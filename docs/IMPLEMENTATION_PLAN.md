# Project Mixer Attention Layer 実装プラン

## 1. 目的

Project Mixer の中心コンセプトを、単なる「複数Project・複数Agentの統合UI」から次の段階へ進める。

> 複数Project・複数Agentが同時に動作していても、人間が常に全体を監視する必要がなく、今必要な情報だけを受け取れる環境を作る。

目标是、Agent的信息量を増やすことではなく、人間が処理しなければならない情報量を減らすこと。

最終的には Project Mixer が、人間とAgentの間に入る **Attention Broker** として機能する。

```text
Agent Events
    ↓
Project Mixer
    ↓
必要性・緊急性・Human Focusを判断
    ↓
Human
```

---

## 1.1 採番と前提

**本プランの段階番号は `AL-1` 〜 `AL-12`（Attention Layer）とする。** 既存の `Phase N`（v2 / doc 16 の正本）とは別体系であり、衝突させない。

> doc 16「番号とフェーズの整理」は採番の正本であり、「新しい Phase 番号を振る前に必ず確認する」と定めている。同一の衝突が過去 2 件（Phase 3 の二重割当、`EDITOR_AND_SPLIT_PLAN.md` 初版の Phase 5 衝突）起きているため、本プランでは別の接頭辞を用いる。

| 既存 | 内容 | 本プランとの関係 |
| --- | --- | --- |
| Phase 0〜5 / 8 | 実装済み（doc 16） | 本プランはこれに依存する |
| **Phase 6** | 動作表示（D15 / kamox 連携・未着手） | **競合しない。** AI→人間方向の主戦場だが本プランとは別の作業線 |
| **Phase 7** | Git 変更状態の簡易表示（D16・優先度低） | **競合しない。** 採番済みだが未着手 |
| **D24** | 注意は値ではなく分布として扱う | **遵守する**（§1.2） |
| **D11 / D13-1** | Shared View の公開範囲、MCP ツールは3〜4個に絞る | **制約**（§8.5） |
| **D19 / D20** | Command 引数は Zod 検証、機能追加は R2 完了まで | **R2 は解除済み。R4/R5 が先**（§16.3） |

### 1.2 D24 への準拠（注意を単値に潰さない）

D24 の決定本文:

> 人間の注意状態を、単一の「アクティブな対象」ではなく、**可視な対象の集合 + キーボード保持先**として表現する。

したがって本プランは以下を**しない**。

- ❌ Inbox を priority のグローバル総順位だけで並べない
- ❌ 「次に何を見る1件」を決める派生値を持たない
- ❌ Human Focus を priority 値に畳み込んで policy 入力にする

本プランが扱うのは **Agent 側の attention（谁が人类を要求したか）** の優先順位付けであり、**Human 側の注意の表現**ではない。両者は混ぜない。Inbox の並び順は §6.3 のとおり空間グループを第一順位とする。

---

# 2. 基本方針

以下を設計上の原則とする。

## 2.1 Agentが動いているだけでは通知しない

```text
Working normally
→ 原則として通知不要
```

人間の介入が必要な状態を中心に扱う。

## 2.2 Agentからの要求と、実際に人間へ見せる重要度を分離する

Agentが `high priority` と宣言しても、そのまま割り込みにはしない。

```text
Agent requested priority
        ↓
Attention Policy
        ↓
Effective priority
```

とする。

## 2.3 別ProjectのAgentが勝手にユーザーの画面を切り替えない

現在の `show_file` の思想を維持する。

```text
同一Project
→ 必要に応じて表示

別Project
→ Attentionとして記録
→ badge / inboxで知らせる
→ Humanが選択したときだけ移動
```

## 2.4 Raw Terminalを最終UIにしない

情報量を段階化する。

```text
Presence
↓
Attention / Summary
↓
Activity Detail
↓
Raw Terminal
```

## 2.5 Human Focusを正式な入力として利用する

現在存在する、

```text
activeProjectId
activeFilePath
cursorLine
selection
activeTerminalTabId
scratchContent
```

をAgent向けContextだけではなく、Project Mixer自身のAttention判断にも利用する。

ただし §1.2 のとおり、これを **priority 値に畳み込まない**。人間が今見ているものは文脈情報（現在のプロジェクトが可視か否か）として扱い、Agent 側の要求の緊急度とは別の軸で扱う。

---

## 2.6 Transport は PTY 固定、信号は階段状に劣化させる

**これが本プランのプラットフォーム基盤となる規則。**

### Transport: PTY 固定

各 agent を PTY で起動し、**その agent 本来の TUI をそのまま描画する**。TUI を protocol 駆動の構造化ビューに置き換えることはしない。

理由:

* Project Mixer の実質的な価値は「その agent の**本物の TUI**が使えること」にある。1 人開発で全 agent の TUI を再実装するのは不可能であり、代替すれば使用者側のストレスになる
* D1「ターミナルを内側に持つ理由が導けない」を弱く保持してきた判断は、実運用のこの時点で妥当性が高まっている（§8.5 の ACP 却下の根拠でもある）

### 信号: agent ごとに精度の階段

**どの agent でも最下段は必ず効く**ようにし、上位段は agent ごとに足す。

| rung | 入手元 | 品質 | 前提 |
| --- | --- | --- | --- |
| **1** | vendor hook / plugin（push） | 正確 | agent が拡張機構を持つ |
| **2** | session ファイルの tail（poll） | 正確 | agent がセッションを永続化する |
| **3** | PTY 出力のヒューリスティック | 粗い | **どの agent でも使える** |
| 補助 | MCP `request_attention` | agent 側の協力が要る | MCP 対応 agent |

rung 3 があるため Attention Layer の検出は常に機能する。rung 1 / rung 2 は agent ごとの小 adapter で、**新しい agent を足すコストをほぼゼロに保つ**。

### 単一 protocol に依存しない

ACP（Agent Client Protocol）の採用を**しない**。理由は §8.5 と §17 に記録する。

### MCP は transport と直交する

agent は PTY で自分の TUI を動かしつつ、**別**で PM の MCP サーバに接続する。両者は排他ではない。既存 `show_file` が既にこの形で動いている。

---

# 3. 全体アーキテクチャ

初期段階では現在のアーキテクチャを大きく変更しない。

既存のイベント処理の後段にAttention Layerを追加する。

```text
[Transport] PTY（各 agent の本物の TUI をそのまま描画）
      │
      ▼
[Signals] 精度の階段（§2.6）
  rung 1  hook / plugin      claude ✓ / opencode ✓
  rung 2  session file tail  devin は Cloud API polling ✓
                            claude / codex / opencode は未実装
  rung 3  PTY heuristic      ✓ すべての agent で有効
  補助    MCP                request_attention（agent 側協力が要る）
      │
      ▼
Normalized Agent Event
      │
      ▼
Existing terminalAttention
      │
      ▼
Attention Mapper
      │
      ▼
AttentionRequest
      │
      ▼
Attention Store
      │
      ▼
Attention Policy
      │
      ├─ Ignore
      ├─ Presence only
      ├─ Inbox
      └─ Interrupt
      │
      ▼
Human UI
```

既存の `terminalAttention` はすぐには廃止しない。

Attention Layerをその上に追加し、段階的に移行する。

### 3.1 状態権威の所在（D20 への準拠）

`src/store/index.js` の `terminalAttention` は、リファクタリング R2 で **single source of truth** として確定済みである。ここに別の Store を並置すると、**R2 で一度踏み抜けた二重管理が再発する**。

したがって次のとおりとする。

| 対象 | 権威 |
| --- | --- |
| 入力待ち・バッジなど**表示に必要な最小状態** | `src/store/index.js`（現行のまま。変更しない） |
| **AttentionRequest の一覧と状態遷移** | 新設の Attention Store（AL-2） |

接続は **一方向**にする。

```text
terminalAttention （store, 変更しない）
        ↓ Attention Mapper（純粋関数）
Attention Store（唯一の writer）
        ↓
UI / MCP / Policy
```

**Attention Store は `terminalAttention` を直接書き換えてはならない。** 逆向きも禁止。例外は「AL-1 で `terminalAttention` Attention Store へ**移動**し、二重管理自体を消してしまう」場合のみ（§4.6）。

---

# 4. AL-1: AttentionRequest の導入

## 4.1 目的

Project Mixer内で、

> 「人間の確認・判断・操作が必要な出来事」

を正式なDomain Objectとして表現する。

---

## 4.2 データモデル

初期版は以下程度に留める。

> **識別子の命名は既存コードに揃える。** 実装上の端末識別子は `tabId: number`（`agent_notification_received` / `terminalAttention[tabId]`）であり、`sessionId` は既に **agent セッションの id**（`terminalAgentBindings[tabId].sessionId`）を表す。`terminalId` という語は使わない。

```ts
export type AttentionKind =
  | 'question'
  | 'decision'
  | 'blocked'
  | 'error'
  | 'review'
  | 'completed'
  | 'info'

export type AttentionPriority =
  | 'low'
  | 'normal'
  | 'high'

export type AttentionSource =
  | 'agent'
  | 'hook'
  | 'terminal'
  | 'system'

export interface AttentionRequest {
  id: string

  projectId: string
  /** 既存コマンド / store の識別子と型を揃える */
  tabId?: number
  /** agent セッション。既存の terminalAgentBindings[].sessionId と同じもの */
  sessionId?: string

  kind: AttentionKind

  requestedPriority: AttentionPriority
  effectivePriority: AttentionPriority

  /**
   * 人間の入力を止めるか。
   * 既存 terminalAttention.waiting に対応する。true のあいだ
   * completion / lifecycle 更新で解除してはならない（§4.4）。
   */
  blocking: boolean

  title: string
  summary?: string
  reason?: string

  source: AttentionSource
  confidence?: number

  filePath?: string
  line?: number
  endLine?: number

  createdAt: number
  updatedAt: number

  acknowledgedAt?: number
  resolvedAt?: number
}
```

---

## 4.3 状態

AttentionRequestは最低限以下の状態を持つ。

```text
OPEN
↓
ACKNOWLEDGED
↓
RESOLVED
```

意味は以下。

### OPEN

まだ人間が確認していない。

### ACKNOWLEDGED

人間が存在を認識した。

まだ対応は終わっていない。

### RESOLVED

問題が解決した、または不要になった。

### ただし RESOLVED は条件付き

**`blocking` が true の AttentionRequest は、`blocking` が false になるまで RESOLVED にしてはいけない。**

`src/notifications/state.mjs` に既にある不変条件:

> Once input is required, keep the amber waiting state until there is direct evidence of a user response. Generic lifecycle updates can arrive late or out of order, so neither working nor completion may clear it.

`turn_completed` はこの条件により `waiting` を消せない。Attention Layer は同じ制約を継承する。`turn_completed` / `turn_started` を `RESOLVED` に写すのは、**その AttentionRequest の `blocking` が既に false の場合のみ**。

---

## 4.4 既存terminalAttentionからの変換

まずはルールベースで変換する。

例:

```text
waiting
→ kind: question
→ blocking: true
→ priority: normal
→ RESOLVED しない（blocking が false になるまで）

failed
→ kind: error
→ blocking: false
→ priority: high

unread completion
→ kind: completed
→ blocking: false
→ priority: low
```

> **訂正（2026-10、実装時に判明）**: 当初 `failed` を `blocking: true` と書いていたが誤り。`blocking` は「人間が対応するまで agent が進めない」状態でなければいけない。失敗は終端状態であり入力要求ではない。`src/notifications/state.mjs` も `turn_failed` で `waiting` を false にする（"a failure is a higher-priority terminal state"）ため、`blocking: true` のままでは解除 pin が外れず、action を取れない amber が永久に残る。実装は `blocking: false` を採用。

Agent種別によって初期マッピングを多少変更してもよいが、できるだけ共通モデルへ正規化する。

**Mapper は純粋関数にする。** `terminalAttention` を引数に取り、`AttentionRequest[]` を返す。副作用を持たない。これにより §3.1 の一方向接続と、既存 store を変更せずに検証できる。

**「1 状態 = 1 リクエスト」の対応表を明示する。** 複数 AttentionRequest を1つの waiting 状態から作ると、解除条件が曖昧になる。既存 `kind`（`turn_started` / `needs_attention` / `turn_completed` / `turn_failed`）と AttentionKind の対応表を AL-1 の成果物に含める。

### 入力元ごとの rung（§2.6 の実装状況）

Mapper は**どの rung から来たイベントでも同じ AttentionRequest に正規化する**。rung は実装詳細であり、AttentionRequest には持たせない。

| agent | 使っている rung | 実装 |
| --- | --- | --- |
| claude | 1（hook）+ 3 | ✅ `hook-settings.cjs` |
| opencode | 1（plugin）+ 3 | ✅ `src/main/opencode-plugin-source.cjs` |
| devin | 2（Cloud API polling）+ 3 | ✅ `src/main/devin-session-monitor.cjs` |
| codex | 3 のみ | ✅ PTY ヒューリスティック |
| claude / codex / opencode の session file tail | 2 | ❌ **未実装（AL-1 の候補）** |
| 上記以外の新規 agent | 3 のみ | ✅ **設定不要で検出が働く** |

**rung 2（session ファイル tail）は費用対効果が最も高い。** agent 側の hook 実装も protocol 対応も不要で、TUI に一切触ずに turn lifecycle と waiting が取れる。`SESSION_HISTORY_PLAN.md` が実測済みのパース仕様をそのまま使える。

---

## 4.5 完了条件

以下が確認できればAL-1完了。

- Claudeの入力待ちからAttentionRequestが生成される
- Codexの入力待ちからAttentionRequestが生成される
- OpenCode lifecycle eventからAttentionRequestが生成される
- failed eventからerror Attentionが生成される
- completionはlow priorityとして扱える
- **completionイベントが blocking な AttentionRequest を消さない**（回帰テストで固定）
- resolveできる
- project / tab / sessionとの対応が保持される

---

## 4.6 二重管理を残さない（AL-1 の隠れた必須条件）

Mapper を書いて既存 store と並行稼働させ、そのほかの機能を追加しない。**これが D20 の再発**。

Attention Store を書き始める時点で、`src/store/index.js` の `terminalAttention` は **Attention Store へ移動済み**でなければならない。

```text
OK（AL-1 完了時）
  terminalAttention  ──移動──▶  Attention Store（唯一の writer）

NG
  terminalAttention ──mapper──▶ Attention Store ──UI──▶ （二つが別々に更新される）
```

移動は AL-1 の範囲に含めるか、AL-2 の冒頭で1コミットとして行う。**どちらでも構わないが、二重管理のまま AL-3（Inbox UI）へ進まない。**

### 4.7 実施結果（2026-10）

**`renderer.js` の `setState({ terminalAttention })` は 1 箇所だけ**に絞った。`commitTerminalAttention()` が `setState` と `reconcileAttention()` を同時に呼ぶため、Attention Store を取りこぼす経路が存在しなくなった。4 つの遷移コマンド（`agent_notification_received` / `agent_notification_seen` / `terminal_set_waiting` / `terminal_clear_attention`）すべてがこの 1 箇所を通ることを静的テストで固定した。

規律に頼るのではなく構造で解決した点が重要（D20 の教訓）。テストは `setState({ terminalAttention` の出現が **1 箇所であること**を assert するため、5 つ目の経路が増えたら落ちる。

**加えて 2 つの経路を開いた。** どちらも「reducer が entry を消した」ケースで、既定の `reconcile()` は blocking 項目を残すため、明示的に落とす必要があった。

| 状況 | 経路 | 理由 |
| --- | --- | --- |
| タブを閉じた / PTY 終了 | `forgetTabAttention(projectId, tabId)` | 回答すべき端末が無い。amber が端末より長生きしてはいけない |
| 人間が入力した | `answerTabAttention(projectId, tabId)` | **blocking を解除できる唯一の経路**。入力したキー入力自体が答え |

`answerTabAttention` に `cause === 'input'` のガードを入れたのは重要で、`state.mjs` は `cause: 'output'`（リサイズによる赤画）を既に拒否する。将来ここが緩れると**赤画が「答え」と推断され、答えずに prompt が消える**。

---

# 5. AL-2: Attention Store

## 5.1 目的

複数Project・複数Agentから来るAttentionを、一つの場所で管理する。

** Attention Store が AttentionRequest の唯一の writer である**（§3.1）。

---

## 5.2 Store API

最低限以下を用意する。

```ts
createAttention(request)

updateAttention(id, patch)

acknowledgeAttention(id)

resolveAttention(id)

getAttention(id)

getOpenAttention()

getProjectAttention(projectId)

getTabAttention(tabId)
```

UIから直接内部配列を操作しない。

---

## 5.3 Derived State

以下をStore側から取得できるようにする。

```ts
needsHumanCount

highPriorityCount

projectAttentionCounts
```

例えばProject Sidebarでは、

```text
Project A    !
Project B
Project C    2
```

のような表示に利用する。

### 「次に何を見る1件」は作らない

`oldestOpenAttention` / `nextAttention` のような**単一値を返す派生プロパティは持たない**。§1.2 の D24 違反になるため。

人間が見ているものは複数同時に存在し得る（可視ペイン群 + キーボード保持先）。「次に1件」を決めることは、その分布を単値に潰すことになる。

必要なら **集合** を返す。

```ts
/** 現在の可視ペインとキーボード保持先に対応する Attention の集合 */
getAttentionInView(paneIds: number[], hasFocusTabId: number | null)

/** 視界の外にある open Attention の集合 */
getAttentionOutOfView()
```

並び順は AL-3（Inbox）で空間グループごとに決める（§6.3）。

---

# 6. AL-3: Attention Inbox

## 6.1 目的

ProjectやTerminalを探すのではなく、

> 「今、人間が見るべきもの」

から作業へ入れるNavigationを追加する。

---

## 6.2 初期UI

最初はシンプルな一覧でよい。

```text
Needs You
─────────────────────────────
IN VIEW
Project A / Claude
Database schema decision
2 min ago

OUT OF VIEW
─────────────────────────────
Project C / Codex
Tests failed after migration
8 min ago

─────────────────────────────
2 items need you
```

表示する情報は最低限、

- Project
- Agent
- title
- kind
- priority
- 経過時間

だけでよい。

詳細説明を一覧に詰め込みすぎない。

---

## 6.3 並び順

**空間グループを第一順位とする。** priority だけで全局に並列しない（§1.2 の D24）。

```text
1. IN VIEW（現在のプロジェクト / 可視ペイン / キーボード保持先に対応）
   ↓ グループ内では effectivePriority → blocking → 古い順
2. OUT OF VIEW（視界の外）
   ↓ グループ内では effectivePriority → blocking → 古い順
```

この順序は「人間が今最も目を遣う場所に近いものを先に見せる」という意味であり、priority の総順位ではない。

**視界の中に blocking が1件でもあれば、Inbox の先頭はそれになる。** ただし「次に1件」という単一値は公開しない（§5.3）。

---

# 7. AL-4: Attention → Context Navigation

## 7.1 目的

Attentionを確認したあと、人間に対象を探させない。

```text
Attention
↓
1 click
↓
必要な場所
```

を実現する。

---

## 7.2 Navigation Target

AttentionRequestには可能な限り以下を保持する。

```text
projectId
tabId
filePath
line
endLine
```

優先順位は、

```text
File + line
↓
Terminal (tabId)
↓
Project
```

とする。

### `show_file` との重複について

`filePath` / `line` / `endLine` による移動は、既存 MCP ツール `show_file(path, line, endLine)` が**同じ処理**を行う。

**新しい移動経路を作らない。** 内部で `preview_open` / `preview_reveal` コマンド（`show_file` が内部で分解して使うもの）を使う。Agent 側の経路は `show_file` が担うので、ここは Human → UI への経路として実装する。

---

## 7.3 期待動作

例えば、

```text
Project A / Claude
"auth.ts の変更を確認してください"
```

をクリックすると、

```text
Project Aへ移動
↓
auth.tsを開く
↓
対象行を表示
```

する。

別のケースでは、

```text
Claude is waiting for input
```

なら、

```text
Project A
↓
該当Terminal
```

へ移動する。

---

# 8. AL-5: MCP `request_attention`

## 8.1 目的

Terminal scrapingやHookだけではなく、Agent自身が構造化されたAttention要求を送れるようにする。

---

## 8.2 MCP Tool

例:

```ts
request_attention({
  kind: 'decision',
  title: 'API compatibility decision',
  summary:
    'Breaking changeにするかcompatibility layerを残すか判断が必要です。',
  priority: 'normal',
  blocking: true,
  filePath: 'src/api/users.ts',
  line: 84
})
```

---

## 8.3 Agentから送信できる内容

初期版では制限する。

```text
kind
title
summary
priority
blocking
filePath
line
endLine
```

Agentが任意のUI操作を直接指定する方式にはしない。

---

## 8.4 MCP Session Contextの利用

既存のMCP sessionに、

```text
projectId
ptyId
cwd
sessionId
```

があるため、Agent側にprojectIdやtabIdを明示させる必要はない。

Mixer側で自動付与する。

これにより、

```text
Agent
↓
request_attention()
↓
Project Mixer
↓
どのProject / Terminalから来たか自動判定
```

を維持する。

> **この前提は transports の選択に依存する。** 現在は per-PTY トークンが機能しているため成立するが、固定 URL 化を採ると成立しない。詳細は §8.5。

---

## 8.5 認証の決定（2026-10 確定）

**結論: per-PTY トークンを維持し、固定 URL 化は凍結する。**

### (1) 前提の確認: per-PTY トークンは機密性を守っていない

claude / codex は MCP 接続先を**コマンドライン**に持つため、同一ユーザーの任意プロセスから読很容易。
`PM_MCP_URL` / `PM_HOOK_TOKEN` も環境変数であり、agent が `env` を実行すれば見える。
doc 11 の D13-4 もこれを明記していた。

```text
claude.exe --mcp-config {"mcpServers":{"project-mixer":{"type":"sse",
 "url":"http://127.0.0.1:47822/s/<token>"}}}
```

32 バイトの乱数でも **token 自体は漏れる**。したがって per-PTY トークンが買うのは機密性ではなく **帰属の作用域**（漏れた場合、1 プロジェクト分の偽装に留まる）である。

### (2) 本来の防御は既に存在する

| 相手 | 防御 |
| --- | --- |
| 別の OS ユーザー | `127.0.0.1` バインド |
| ブラウザ経由 cross-origin / DNS rebinding | Host ヘッダ検証 + Origin ヘッダ拒否 |

これらは最初の MCP サーバを実装した時点で入っており、`src/mcp/server.cjs` と `main.js` に現存する。**認証を捨てたのではなく、認証が最初からここにあった**。

### (3) 固定 URL 化・Bearer 認証を採らない理由

* **token の lifecycle**: 現在は `pty:create` で生成し `pty:exit` で revoke する（自動生成・自動破棄）。固定 URL 化のグローバルトークンは再起動で失効するため userData に永続化が必要になるが、PM は secrets を 1 つも永続化していない
* **profile 分離の破壊**: Phase 0.1 で dev 47852 / default 47822 に意図的に分離し、`requestSingleInstanceLock` で同時起動を許している。固定ポートはこの前提を壊す
* **手動設定の 2 ステップ化**: 起動時 override を持つ agent では A でも B でも 1 ステップで変わりがない。无 override の agent では URL 登録 + token 登録の 2 ステップになり、`devin mcp add` の headers 対応も未確認

### (4) ACP を採用しない

ACP（Agent Client Protocol）を第一レーンにする案は **却下**。理由は §2.6 と §17。

### (5) D11 の判定軸

`request_attention` は実行でもビュー共有でもない。**Shared View には載せず、Agent から Human への通知経路として別立てにする。** Shared View のツール数（D13-1 の「3〜4個に絞る」）には数えない。

### (6) `request_attention` の位置づけ

**補助チャネル**である。検出の主経路は §2.6 の rung 1〜3 であり、`request_attention` は rung 3 の誤検出を補う補助的な経路として位置づける。
Agent 側が呼ばないと伝わらないので、**検出の代替にはしない**。

### (7) 濫用に対するガード

以下は最初から入れる。

- 同一 `sessionId` からの同一 `kind` + `title` は冪等（重複生成しない）
- 1 セッションあたりの open Attention 数に上限
- Agent が指定できる `blocking` は `false` まで（`blocking: true` は人間入力を止めるので Agent 側では決められない）
---

---

# 9. AL-6: Attention Policy

## 9.1 目的

Agentから来たAttentionをそのまま人間へ通知するのではなく、Mixer側で表示方法を決める。

---

## 9.2 初期Policy

最初はルールベースにする。

LLM判断は入れない。

例:

```text
blocking=true
→ 最低 normal

kind=error
→ high

kind=completed
→ low

別Projectのlow priority
→ Inboxのみ

resolved
→ 非表示
```

### effectivePriority は Agent の宣言と kind だけで決める

**「現在見ているProject」「現在のファイルを開いている」等の Human Context は effectivePriority に入れない。** §1.2 の D24 に反する（人間が注視している対象を1つに決める compounding になる）。

Human Context が影響するのは **§9.3 の presentation と §6.3 の並び順グループ** のみ。

> 旧案の「現在見ているProject → visibilityを1段階上げる」は削除する。§10.3 のとおり、視界内の Attention は** priority を変えずに** Inbox の先頭グループへ移る。

---

## 9.3 出力レベル

Attention Policyの結果は、priorityではなく「人間への出し方」として扱う方がよい。

```ts
type AttentionPresentation =
  | 'hidden'
  | 'presence'
  | 'inbox'
  | 'highlight'
  | 'interrupt'
```

### hidden

表示しない。

### presence

Agent / Projectの状態だけ変える。

### inbox

Attention Inboxへ入れる。

### highlight

SidebarやInbox上で強調する。

### interrupt

将来的な明示通知。

初期版では `interrupt` はほぼ使用しない。

---

# 10. AL-7: Human Focusとの統合

## 10.1 目的

人間が今何に集中しているかをAttention Policyへ利用する。

**ただし §1.2 の D24 に従い、Human Focus を priority 値に畳み込まない。** Policy への入力は「空間的な位置づけ（視界内か否か）」であり、「緊急度」ではない。

---

## 10.2 利用するHuman Context

既存Storeの、

```text
activeProjectId
activeFilePath
cursorLine
selection
activeTerminalTabId
```

を利用する。

さらに、Phase 8 のマルチペインで既に存在する以下を加える（`markShownTabs()` / `placeSurfaces()` が算出済み）。

```text
可視ペインの集合
各ペインの activeTabId
キーボード保持先のペイン（focusedPane）
```

追加候補:

```text
lastProjectSwitchAt
lastInputAt
idleDuration
focusMode
```

---

## 10.3 初期ルール

**priority は変えない。changing的不是 priority，而是「视界内 / 视界外」という提示位置。**

```text
HumanがProject Aを見ている
+
Project A Agentからnormal priority
→ sidebar/inboxで少し強調（视界内グループ）

HumanがProject Aを見ている
+
Project F Agentからlow priority
→ out of view グループに回すだけで、priority は変えない

HumanがProject Aを見ている
+
Project F Agentからblocking error
→ out of view だが interrupt 相当（§9.3）。視界内の blocking と同格に扱う
```

とする。

「視界内だから low を上げる」処理は**入れない**。それが D24 が潰そうとしている単一化に同じ故障をする。

---

# 11. AL-8: Agent Presence

## 11.1 目的

文章を読まなくてもAgentの状態を把握できるようにする。

---

## 11.2 初期状態

状態数を増やしすぎない。

```text
idle
working
needs-attention
error
done
```

程度から始める。

### 既存 kind への対応表

実装既存の `terminalAttention[].kind` は 4 値（`turn_started` / `needs_attention` / `turn_completed` / `turn_failed`）。**新しい中間表現を足さず、既存値から導出する。**

| 既存 kind | Presence | 根拠 |
| --- | --- | --- |
| （エントリなし） | `idle` | `needs_attention` も `unread` も立っていない |
| `turn_started` | `working` | 入力は受け付け済み・応答待ち |
| `needs_attention` | `needs-attention` | `waiting: true`。`blocking` と同じ条件 |
| `turn_failed` | `error` | — |
| `turn_completed` | `done` | `unread: true` のときのみ 나타す |

`idle` と `done` の区別はバッジを出さないので、実装上は `done` は「直前に完了した」短時間の衰减で表現してよい（§15 の Information Decay と同じ考え方）。

---

## 11.3 UI

Project SidebarやTerminal Tabで、

```text
Project A        ◌
Project B        !
Project C        ✓
Project D
```

程度の低密度表示にする。

目的は、

> 詳細を読ませる

ことではなく、

> 周辺視野で状況を認識させる

こと。

---

# 12. AL-9: Event History

## 12.1 目的

Information CompressionやResume Summaryの元になるデータを蓄積する。

---

## 12.2 Event Model

例:

```ts
interface AgentEvent {
  id: string

  projectId: string
  /** 既存コマンド / store の識別子と型に揃える（§4.2） */
  tabId?: number
  /** agent セッション */
  sessionId?: string

  type: string

  timestamp: number

  title?: string
  data?: unknown

  source:
    | 'hook'
    | 'terminal'
    | 'mcp'
    | 'system'
}
```

`agentId` は使わない。既存実装に agentId は無く、`sessionId` がその役割を持つ（`terminalAgentBindings[tabId].sessionId`）。

---

## 12.3 注意点

すべてのTerminal出力をEvent化しない。

意味のある状態変化を中心にする。

例:

```text
agent_started
agent_waiting
agent_resumed
agent_completed
agent_failed

test_started
test_failed
test_passed

attention_requested
attention_resolved

file_requested
human_switched_project
```

---

# 13. AL-10: Resume Summary

## 13.1 目的

別Projectへ移った人間が、戻ったときに途中経過を追わなくて済むようにする。

---

## 13.2 最初の表示

Projectへ戻った際、

```text
Since you left

✓ Authentication migration completed
✓ Tests passing
! 1 decision waiting
```

程度を表示する。

---

## 13.3 最初はルールベースでよい

例えば、

```text
agent_completed
+
tests_passed
+
attention_request
```

から、

```text
1 agent completed
Tests passing
1 item needs your attention
```

と生成する。

### `SESSION_HISTORY_PLAN.md` との重複

`docs/SESSION_HISTORY_PLAN.md` は 4 provider（claude / codex / opencode / devin）のセッション一覧・resume・トランスクリプトを扱う。**H1（一覧 + resume）は実装済み**（`src/main/session-history.cjs` 相当が `create_terminal` の `resumeSessionId` に流れている）。

本 AL-10 で必要なのは「セッション一覧」ではなく **Event History（AL-9）からの要約**であり、セッションファイルのパース自体は別物。ただし両者は同じファイル群を読むため、**スキャナは共有する**（`SESSION_HISTORY_PLAN` の設計判断「スキャナは `src/main/` 配下、main だけがホーム外を読む」に従う）。

二重実装しないこと。

LLM Summaryは後から追加する。

---

# 14. AL-11: Information Compression

## 14.1 目的

Agentが生成した大量の活動履歴を、人間が理解するための小さな情報へ変換する。

---

## 14.2 情報階層

```text
Raw Event
↓
Activity
↓
Milestone
↓
Outcome
```

例:

```text
15:03 test failed
15:05 edited foo.ts
15:06 test failed
15:08 edited bar.ts
15:10 test passed
```

を、

```text
Tests initially failed.
Agent fixed two issues.
Tests are now passing.
```

へ圧縮する。

さらに時間が経過したら、

```text
✓ Tests passing
```

まで落とせる。

---

# 15. AL-12: Information Decay / Forgetting

## 15.1 目的

人間に永久に情報を覚えさせない。

データ削除ではなく、

> UI上で表示する解像度を時間とともに下げる

ことを基本とする。

---

## 15.2 初期案

```text
0〜5分
→ detailed activity

5〜60分
→ summary

1〜24時間
→ milestone / outcome

1日以上
→ current stateのみ
```

Project Mixer内部ではraw eventを保持してもよい。

---

# 16. Core / Runtime整理

Attention Layerが一通り動いてから、本格的にRenderer依存を減らす。

---

## 16.1 目標構造

```text
src/
  core/
    projects/
    agents/
    attention/
      attention-types.ts
      attention-store.ts
      attention-policy.ts
      attention-mapper.ts

    human-context/
      human-context-store.ts

    events/
      event-types.ts
      event-store.ts

  main/
    pty/
    hooks/
    mcp/
    notifications/

  renderer/
    attention/
    projects/
    terminal/
    editor/
```

---

## 16.2 最終的な依存方向

```text
Renderer
    │
    ▼
Project Mixer Core
    ▲
    │
Main Process
    ▲
    │
Hooks / MCP / PTY / Agent
```

Rendererをapplication stateの唯一の所有者にしない。

将来的には、

```text
Electron Renderer
CLI
Remote UI
Mobile
```

などが同じCoreを利用可能な形にする。

ただしRemote / Mobile自体を直近の実装対象にはしない。

---

## 16.3 着手のゲート（R4 / R5 が先）

`REFACTORING_PLAN.md` の R4（main service 分離）と R5（統合検証）が**未完了**。同計画書「機能追加とのゲート」は次のとおり。

> | agent状態・hook通知の追加 | R0–R2 |
> | Git状態表示 | R0–R2、main側処理を増やすならR4 |

R0–R2 は完了済みだが、**R4 の残り（`pty-service` / `hook-service` / `file-service` 分割、IPC 戻り値の `{ ok, value } | { ok, code, message }` 標準化）と R5（実 Electron 検証）が残っている**。本プランは main 側の状態と IPC を大きく触るため、順序を固定する。

> **AL-1（型と mapper）は R4 完了後に着手する。** R4 の IPC 戻り値標準化は AL-9（Event History の main 側蓄積）に直接効くため、先に片付ける。

なお R2 は **renderer の store を SSOT 化**して完了済みであり、本節 16.2 の「Renderer を application state の唯一の所有者にしない」は**R2 とは逆方向**である。これは矛盾ではなく長期目標だが、**その間の二重管理は作らない**（§3.1 / §4.6）。

---

## 16.4 パッケージングへの注意

`package.json` の `build.files` は現在、`src/mcp` `src/ports` `src/files` `src/main` `src/commands` `src/store` を明示列挙している。

- renderer 側の `src/editor` `src/keybindings` `src/notifications` `src/preview` `src/ui` 等は **esbuild が `dist/renderer.bundle.js` に束ねる**ため追加不要
- 一方 **main 側から `require` する `src/core/**` は明示追加が必要**

`src/core/` を置く段階になったら、`build.files` への追加を同じコミットに含めること。

---

# 17. 当面やらないもの

Attention Layerが安定するまで以下は後回しにする。

- 大規模Orchestration
- Agent間Task DAG
- Remote Runtime
- Mobile client
- Worktree中心への全面移行
- 高度なLLM priority判定
- Agentごとの複雑なアニメーション
- 自動Project switching
- 完全なIDE機能拡張
- 大規模Editor強化

Project Mixerの中心価値と直接関係しない機能追加を一度抑える。

## 17.1 却下した案: ACP（Agent Client Protocol）

**ACP を agent 統合の第一レーンに据える案を却下した**（2026-10）。ACP は Zed Industries が 2025-10 に公開した editor ↔ agent 間の標準 protocol で、Claude / Codex / Gemini / OpenCode / Cursor / Copilot / Goose / Kimi / Qwen などが対応し、JetBrains / VS Code も client として対応している。選択肢としては十分に有望に見えた。

### 却下の理由

**1. ACP は TUI を出さない。**

ACP client は protocol の `session/update` から**構造化ビュー**を描画する。agent の本物の TUI ではない。実例として agent-of-empires は同一アプリ内で「tmux attach を PTY 経由で中継した実ターミナル」と「ACP セッション用の構造化ビュー」を別々に描画している。

Project Mixer の実質的な価値は「その agent の**本物の TUI**が使えること」であり、1 人開発で全 agent の TUI を再実装することはできない。代替は使用者側のストレスになる。

**2. 全 agent が ACP 対応になる保証がない。**

2026-10 時点で 40+ agent が対応しているが、**実装品質は agent ごとにまちまち**。opencode の ACP 実装は VS Code 連携用途でも以下が未実装である。

```text
Not Yet Implemented:
* Streaming responses (buffered for now)
* Tool call progress reporting
* Real-time status updates
* Cancellation support
```

これは「入力待ちの検出」に使いたい event そのものである。

**3. adapter 供給網への依存。**

Claude と Codex は ACP 公式実装ではなく **Zed / community が保つ adapter**（`claude-code-acp` 等）を経由する。ベンダーが ACP を放棄した場合に詰む。

**4. v2 が draft。**

2026-07 に v2 が draft 公開。更新履歴に `Elicitation is Stabilized` / `Tool Call Names are Stabilized` が並んでおり、method 名が動いている。schema を先に固定するな。

### ACP の `terminal/*` は別物である点にも注意

ACP には `terminal/create` / `terminal/wait_for_exit` / `terminal/output` があるが、これは**agent が client 側でコマンドを実行し、結果を tool call に埋めて返す**ためのものである。人間が agent の TUI を見て操作する機能ではない。ACP を「TUI の代替」とみなすのは誤り。

### 再浮上条件

以下がすべて揃ったときだけ再検討する。

* TUI を保ったまま protocol の session 通知を得られる手段が ACP に追加された
* 対応 agent の実装品質が揃う
* PM 相当の host として「TUI と並列に構造化ビューを提供する」構成が 1 人開発で成立すると判断できたとき

`docs/DEVIN_ACP_INTEGRATION_PLAN.md` の判断は §2.6 と整合するため **有効**である。ACP を第一レーンに据える案を却下したことは、その結論の否定ではない。

---

# 18. 最初のMVP

まず以下のケースが完全に動けばよい。

```text
Human
→ Project Aを作業中


Project B / Claude
→ working


Project C / Codex
→ working


Project D / Claude
→ 判断が必要
```

Project Mixerは、

```text
Project A
Project B
Project C
Project D   !
```

とだけ表示する。

Attention Inbox:

```text
Needs You

OUT OF VIEW
Project D / Claude

API compatibility decision

Breaking changeにするか、
compatibility layerを残すか判断が必要です。

[Open]
```

> Project D は Human が見ていないので `OUT OF VIEW` グループに入る。**IN VIEW に1件もない場合、Out of view の先頭がそのまま先頭になる。** Human が Project D へ移動すると、その時点で自動的に IN VIEW 側へ入る（D24 の分布表現）。

Openすると、

```text
Project D
↓
対象TerminalまたはFile
↓
該当箇所
```

へ移動する。

Project B/Cについては何も通知しない。

ユーザーが回答するとAttentionはresolveされる。

---

# 19. MVPの成功条件

次の状態を目標とする。

> 4つ以上のProject、5つ以上のAgentを並行稼働させても、ユーザーが各Terminalを巡回する必要がない。

具体的には、

- Agentが正常に作業しているだけなら確認不要
- 入力待ちを自動検出できる
- Agentから明示的にAttention要求できる
- AttentionをProject横断で一覧化できる
- 視界内の Attention が視界外より上に来る
- Attentionから対象Contextへ一発で移動できる
- 別Projectから勝手にFocusを奪わない
- 回答後にAttentionが正しく消える
- **完了イベントが入力待ちAttentionを消さない**

ことを確認する。

---

# 20. 実装順序

実際の着手順は以下とする。

```text
[前処理・別ライン]
  0. REFACTORING_PLAN R4 残り（pty/hook/file-service、IPC 戻り値標準化）
     → R5 実 Electron 検証
     → AL-1 着手可能

[検出の土台]
  a. rung 2（session ファイル tail）を claude / codex / opencode に足す
     §2.6 の費用対効果が最も高い。TUI に触れず、hook 実装も protocol 対応も不要。
     rung 3 だけに依存する agent を無くしてからAttention 本体に入る

[本プラン]
  1. AL-1  AttentionRequest 型 + terminalAttention mapper
            （§4.6: 二重管理を残さない）

  2. AL-2  Attention Store（唯一の writer）

  3. AL-3  Attention Inbox UI（視界内 / 視界外の空間グループ）

  4. AL-4  Attention → Project / Terminal / File への移動
            （既存 preview_open / preview_reveal を再利用）

  5. AL-6  Attention Policy の最小実装

  6. AL-7  Human Focus を Policy へ接続（priority を変えず位置づけのみ）

  7. AL-8  Presence UI（既存 4 kind から導出）

  8. AL-9  Event History

  9. AL-10 Resume Summary（AL-9 のイベントから生成）

 10. AL-11 Information Compression

 11. AL-12 Information Decay

 12. AL-5  MCP request_attention（補助チャネル。§8.5 で後段に回した）

 13. Core / Runtime 境界を整理（§16）
```

**1〜4 は「型 → Store → mapper → UI」の順を崩さない。** UI を先に作ると、二重管理のまま Inbox が動く状態を作ってしまう。

**AL-5 を最後に回した理由**: 検出の主経路は rung 1〜3 であり、`request_attention` はその補助にすぎない（§8.5(6)）。Agent 側の協力が要るため、検出そのものをこれに依存させることはできない。

---

# 21. 最重要の設計指標

Project Mixerの新機能を追加するとき、

> 「より多くの情報を表示できるか」

ではなく、

> **「ユーザーが見なくてよい情報を増やせるか」**

を評価軸にする。

理想状態は、

```text
12 Agents running
        ↓
11 Agents require nothing
        ↓
Project Mixer hides them
        ↓
1 Agent needs a decision
        ↓
Human sees 1 thing
```

である。

ただしこの図の「Human sees 1 thing」は **Agent 側の要求が1件という意味**であり（D24 §1.2）、人間が同時に複数の対象を見ている事実（可視ペイン群 + キーボード保持先）を崩すものではない。Inbox が1件でも、視界には複数のペインが並びうる。

最終的な成功条件は、

> **多数のAgentが動いていることを人間に意識させないこと。**

Project MixerはAgentを管理するDashboardではなく、

> **人間と多数のAgentの間で、Attention・Context・Interruptionを仲介するソフト**

として設計する。
