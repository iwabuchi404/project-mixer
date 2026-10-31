# Devin Hooks 通知統合計画

**作成日**: 2026-08-13

**状態**: D0b反映・OSC Attention経路実装済み ・ **D1–D4 実装済み (2026-10-30)**

D1–D4実装メモ:

- **D1** (`e49d486`): `src/main/agent-events/providers/devin.cjs` — Hook payload mapping (UserPromptSubmit→turn_started, Stop→turn_stop_requested+stopHookActive)、OSC通知 (needs_attention/turn_completed)、turn tracker (stale Stop判定+dedupe)。service側は `provider === 'devin' || agent_source === 'devin'` で迂回。
- **D2** (`5a6fadf`): `src/main/hooks/hook-bridge-source.cjs` — 統合bridgeソース（allowlist転送・64KiB stdin cap・800ms timeout・常時exit 0・`--provider`判定・claude/codex後方互換）。ルーティング: `resolveNotificationTarget` に sessionId binding store (`createSessionBindingStore`) を追加し ptyId → session binding → cwd → unattributed のfallback chainを実装。PTY起動時の `PROJECT_MIXER_PORT_FILE` / `PROJECT_MIXER_PTY_ID` 注入は既存のまま。
- **D3** (`3f0770e`): `src/notifications/state.mjs` — `turn_stop_requested` をno-op化（OSC finished のunread badgeを消さない・waitingをprotect）。UserPromptSubmit (turn_started) はDDLどおりwaitingをクリア。
- **D4** (`bdac228`): runtime選定は**Electron Node-mode wrapper**（`ELECTRON_RUN_AS_NODE=1` + PM実行ファイル)、system Node不要。`src/main/hooks/devin-hook-config.cjs` — user-level `%APPDATA%\devin\config.json` の `hooks` merge (UserPromptSubmit/Stop・idempotent・backup + atomic replace・parse不可は拒否・不明field/既存hook保持)。`src/main/hooks/devin-bridge-install.cjs` — appData共通 integration directory (profile非依存) へ bridge+wrapper展開。UIは Helpメニュー (Status / Enable / Disable のダイアログ) ＋ IPC `devin-hook:status/enable/disable`、preloadに `devinHookStatus/Enable/Disable`。
- 残タスク: D5 実CLI検証（実装結果.mdへ記録）、Setup statusの「last probe version」表示。
- **D5進捗 (2026-10-31, `d9b3bd0`)**: 実CLI (Devin CLI 3000.11.234) での2件の実装FixとE2E検証。実payload観察: stdin JSONは `{"hook_event_name":"UserPromptSubmit","prompt":{"省略"},"session_id","prompt_id"}` / `{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message","session_id","prompt_id"}` (snake_case, cwd無し)。bridgeの `--provider devin` 値が事件名として誤認識されるバグと、backslash quote形式のconfig commandがDevinの `bash -c` 実行で失敗する問題 (forward-slash quoted strawman/commandへ修正) を修復し、**PM内devin --print でのE2E成功**: `[hook] Routed devin UserPromptSubmit: kind=turn_started ptyId=1` / `[hook] Routed devin Stop: kind=turn_stop_requested ptyId=1`。未確認: D5残ケース (permission待ち・2 terminals同時・receiver停止・packagedなど)、TUI(renderer経由)でのargs渡しは renderer.js:4975 の `args: []` ハードコードが原因で未対応（terminal-launch WIPで対応予定）。

**対象**: Project Mixer v2 / Devin CLI 通知統合

**実装結果**: [Devin CLI 通知統合 実装結果.md](./Devin%20CLI%20通知統合%20実装結果.md)

## 結論

DevinはACPを使用せず、**既存のDevin TUIをそのままPTY上で利用し、Lifecycle Hooksと公式terminal notificationをsemantic side-channelとしてProject Mixerへ接続する。**

Devin CLIは現在、`UserPromptSubmit`、`PermissionRequest`、`Stop`、`SessionStart`、`SessionEnd`などのLifecycle Hooksを正式に提供している。Command HookにはJSONがstdinで渡され、`session_id`と、prompt開始後のイベントにはターン単位の`prompt_id`が含まれる。`SessionStart`など最初のpromptより前のイベントでは`prompt_id`がない。

基本経路:

```text
Devin TUI
   │
   ├── PTY ── OSC 9 / 777 ──→ xterm.js ──→ Attention Store
   │
   └── Lifecycle Hooks
          │
          │ JSON stdin
          ↓
     PM Hook Bridge
          │
          │ localhost HTTP
          ↓
    Hook Receiver
          ↓
 AgentLifecycleEvent
          ↓
   Attention Store
          ↓
 project / terminal badge
```

目的はDevinを操作・抽象化することではなく、

> **Devin自身が持っている意味情報を、人間のAttention Stateへ翻訳する**

こと。

---

# 1. 利用するHooks

初期実装では次の信号だけ扱う。

| Devin signal | Project Mixer | 用途 |
| --- | --- | --- |
| `UserPromptSubmit` | `turn_started` | 新しいターンの識別 |
| OSC `Devin needs input` | `needs_attention(input)` | 承認または質問待ち |
| OSC `Devin finished` | `turn_completed` | ターン完了 |
| `Stop` | `turn_stop_requested` | ターン終了を試みた事実 |

Devin 3000.4.16ではTUI承認時に`PermissionRequest` Hookが発火しない。承認と通常の質問待ちはOSC payload上区別できないため`input`へ正規化する。`Stop`は完了確定に使わず、Hook側のturn相関情報として扱う。

以下は初版では通知に使わない。

- `PreToolUse`
- `PostToolUse`
- `PostCompaction`
- `SessionStart`
- `SessionEnd`

ただし`SessionStart` / `SessionEnd`はデバッグ・identity確認用にはログ可能。

---

# 2. Event Identity

Devin Hookのイベントには、

```text
session_id
prompt_id
```

が含まれる。ただし`prompt_id`は最初のpromptより前のイベントでは省略される。

`session_id`はセッション中固定、`prompt_id`はユーザーpromptごとに更新され、同じターン中のHookは同じ`prompt_id`を共有する。

Project Mixerでは以下のidentityを使う。

```ts
type DevinHookIdentity = {
  ptyId: number
  sessionId: string
  promptId?: string
}
```

各identityの責務を分ける。

`ptyId`はProject Mixerのruntime routing用。

`sessionId`はDevin sessionの照合用。

`promptId`はturn correlationとstale event除去用。

---

# 3. Lifecycle Eventへの変換

既存の共通Lifecycle modelへ変換する。

```ts
type AgentLifecycleEvent =
  | {
      kind: "turn_started"
      provider: "devin"
      ptyId: number
      sessionId: string
      turnId: string
    }
  | {
      kind: "needs_attention"
      reason: "input"
      provider: "devin"
      ptyId: number
      sessionId?: string
      turnId?: string
    }
  | {
      kind: "turn_stop_requested"
      provider: "devin"
      ptyId: number
      sessionId: string
      turnId: string
      stopHookActive: boolean
    }
```

mapping:

```text
UserPromptSubmit
→ turn_started

OSC "Devin needs input"
→ needs_attention(reason: input)

OSC "Devin finished"
→ turn_completed

Stop
→ turn_stop_requested
```

Hook payloadそのものをrendererへ渡さない。

`turn_stop_requested`を`turn_completed`へ昇格するのはAttention Policy側とし、D0で確認したStop Hook共存条件を満たす場合だけに限定する。

---

# 4. Attention Stateへの変換

Lifecycle Eventと人間向け通知状態を分離する。

```text
Agent Lifecycle
      ↓
Attention Policy
      ↓
UI
```

### UserPromptSubmit

```text
turn_started
↓
以前のwaiting stateを解除
↓
currentTurnId更新
```

白い完了badgeも、新しいpromptを入力した時点で既読扱いにしてよい。

### OSC needs input

```text
needs_attention
↓
amber
```

ターミナルを開いただけでは消さない。

対象PTYへのユーザー入力を、人間が通知を確認して操作を開始したというacknowledgementとして解除する。これはpermissionが承認・拒否されたというprotocol上の確定ではない。

### OSC finished / Stop

```text
OSC finished
↓
turn_completed

Stop Hook
↓
turn_stop_requested（turn相関用）
```

OSC `Devin finished`はDevin自身のterminal notificationなので、完了通知の正規経路として扱う。Stop Hookだけから`turn_completed`へ昇格しない。

対象terminalを現在見ていない場合:

```text
white unread
```

現在そのterminalを見ている場合:

```text
completed
unread = false
```

つまり、

> Hook Event = Agent側で起きた事実
>
> Attention State = 人間が戻る必要があるか

を分離する。

---

# 5. Routing

現在のClaude / Codex Hook receiverと同じローカルHTTP経路を再利用する。

理想:

```text
Devin Hook
↓
PM hook bridge
↓
POST /hook
```

現在のreceiver pathを維持し、providerごとのendpointは増やさない。

bridgeが送るpayloadはraw stdinの転送ではなく、明示allowlistから組み立てる。

```json
{
  "provider": "devin",
  "ptyId": 42,
  "eventType": "Stop",
  "sessionId": "...",
  "promptId": "...",
  "stopHookActive": false,
  "toolName": null,
  "observedAt": "2026-08-13T00:00:00.000Z"
}
```

`observedAt`はDevin payload由来ではなくbridgeが受信時に付与する。prompt、`tool_input`、`tool_response`、環境変数一覧は転送しない。

bridgeは`PROJECT_MIXER_PORT_FILE`からprofile固有のportと起動時生成tokenを読み、HTTP headerで送る。receiverはtoken、Content-Type、body上限、payload schemaを検証してから正規化する。tokenはrendererへ渡さない。

Project Mixer側はproviderごとのHTTP endpointを増やさず、

```text
Claude
Codex
Devin
Grok
...
      ↓
Agent Event Receiver
```

へ寄せる。

---

# 6. PTY IDの渡し方

第一候補:

Project MixerがDevin processをspawnするときに、

```text
PROJECT_MIXER_PTY_ID
PROJECT_MIXER_PORT_FILE
```

等をenvironmentへ追加する。

Hook bridgeがそのenvを読み、HTTP payloadへ入れる。

ただしDevin公式ドキュメントで明示されているHook用環境変数は`DEVIN_PROJECT_DIR`であり、親processから任意のenvironmentがCommand Hookへ継承されることまでは明記されていない。

そのため、実装開始時に小さなprobeを行う。

### Probe

Hook command:

```text
PROJECT_MIXER_PTY_IDを読み取る
↓
一時ログへ値だけ出力
```

確認:

```text
PMから起動したDevin
→ PTY IDあり

通常terminalから起動したDevin
→ PTY IDなし
```

### Gate

環境変数継承が確認できれば採用。

確認できなければ、

1. session_idによるruntime binding
2. 一時runtime token
3. launcher-specific wrapper

の順で代替案を検討する。

cwd routing fallbackは最後の手段とし、複数一致時は既存D17どおり未帰属にする。

最初の正当なHookを`ptyId`付きで受信した時点で、main processに`sessionId → ptyId`を登録する。以後のfallbackはこの明示bindingだけを利用し、session名やcwdから自動作成しない。

---

# 7. Hook Bridge

Claude / Codex用bridgeと可能な限り共通化する。

候補:

```text
project-mixer-hook
```

一つに統合。

stdin:

```json
{
  "hook_event_name": "...",
  "session_id": "...",
  "prompt_id": "..."
}
```

bridge側はLifecycleの意味変換を行わないが、機密情報をmain processへ持ち込まないためのallowlist抽出は担当する。

担当:

1. stdin JSON parse
2. provider判定
3. 許可fieldだけを抽出
4. PM runtime identity追加
5. profile token追加
6. localhostへPOST
7. 成否にかかわらず制限時間内にexit 0

正規化はProject Mixer main process側で行う。

## Timeout / Size Limit

HookがDevin本体を待たせないため、二重に上限を持つ。

```text
Devin Hook timeout: 2秒
bridge HTTP connect / response timeout: 500〜1000ms
stdin上限: 64 KiB
HTTP body上限: 16 KiB
```

上限超過、JSON parse失敗、port file不在、接続失敗、receiver errorはすべて通知を捨ててexit 0とする。stderrへpromptやpayload本文を出さない。

## 配置と実行runtime

user-level設定から参照するため、bridgeをproject directoryへ置かない。通常版とdev profileが共有できるstableなintegration directoryへ配置し、routing先だけを`PROJECT_MIXER_PORT_FILE`でprofile分離する。

packaged版でsystem Node.jsを前提にしない。D0で以下を比較し、署名・更新・アンインストールまで成立する方式を選ぶ。

1. Project Mixer executableをNode modeで起動するthin wrapper
2. standalone helper executable
3. system Node.jsを使うscript（開発時のみ）

採用方式が決まるまでD4の自動設定へ進まない。

---

# 8. Hook設定

Devinはproject-levelでは`.devin/hooks.v1.json`を推奨しているほか、Windowsでは`%APPDATA%\\devin\\config.json`のuser-level設定も利用できる。またClaude Code形式のhook設定も、Claude config importが有効なら読み込まれる。

Project Mixerでは**project内ファイルを自動生成しない。**

推奨:

```text
ユーザーが一度だけDevin通知統合を有効化
↓
user-level hook設定へ追加
↓
PMから起動されたDevinだけbridgeが通知
```

設定UI候補:

```text
Devin Integration

Lifecycle notifications
[ Enable ]

Status:
✓ Terminal notifications detected
○ Hooks configured
```

`/hooks`コマンドでDevin自身が現在ロードしているHookとsource fileを確認できるため、トラブルシュート時に利用する。

`/hooks`が対話UI専用で機械判定できない場合、Setup statusは`configured`と`loaded`を混同しない。D0で非対話の確認手段を調べ、存在しなければUIには`Configured; verify with /hooks`と表示する。

---

# 9. Hook設定内容

以下はuser-level `config.json`内の`hooks`値の概念例であり、設定ファイル全体ではない。

```json
{
  "UserPromptSubmit": [
    {
      "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "project-mixer-hook --provider devin",
          "timeout": 2
        }
      ]
    }
  ],
  "Stop": [
    {
      "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "project-mixer-hook --provider devin",
          "timeout": 2
        }
      ]
    }
  ]
}
```

`UserPromptSubmit`と`Stop`ではmatcherは空または省略可能。`PermissionRequest`は3000.4.16で不発火のため設定しない。terminal notificationはDevinの`notify: "smart"`を尊重し、D0b Probeだけ一時configで`always`を使う。

Hookは**観測のみ**にする。

stdoutへ、

```text
decision
additionalContext
updatedInput
```

等を出さない。

Devinの動作そのものへ介入しない。

---

# 10. Event別dedupe・stale event対策

dedupeは全イベントへ同じkeyを適用しない。

`UserPromptSubmit`と`Stop`は、

```ts
const turnEventKey =
  `${provider}:${sessionId}:${promptId}:${eventType}`
```

をbounded TTL cacheでdedupeする。cacheには上限件数と有効期限を設け、session終了またはPTY終了時にも削除する。

OSC 9とOSC 777は同じpayloadをほぼ同時に送るため、`kind:eventType`をkeyに250ms以内の同一通知をdedupeする。未知のOSC payloadは通知へ変換しない。

### Stale Stop

例:

```text
Turn A
↓
Stop配送遅延

Turn B開始
↓
Turn A Stop到着
```

Store上の、

```text
currentPromptId !== stop.promptId
```

なら、現在のturnをcompletedへ変更しない。

必要ならhistory eventとしてだけ保存する。

---

# 11. 「質問待ち」の扱い

初版では、**DevinのOSC terminal notificationをAttention状態の正規経路として扱う。**

```text
OSC "Devin needs input"
→ amber（input）

OSC "Devin finished"
→ white
```

承認待ちと通常の質問待ちはどちらも`Devin needs input`なので区別しない。画面文言から`approval`を推測せず、共通の`input`として通知する。

---

# 12. PTY Heuristicとの関係

既存の文字列判定による、

```text
Proceed?
Allow
Confirm
```

等は、OSCが取得できない将来version向けの最終fallback候補とする。Devin 3000.4.16ではOSCを優先し、文字列判定を有効化しない。

ただし優先順位:

```text
Devin terminal notification (OSC)
      ↓
Lifecycle Hook
      ↓
PTY text heuristic
```

OSC 9とOSC 777はadapter内で1通知へdedupeする。白い完了通知を画面文字列から生成しない。

---

# 13. 実装段階

## 対象モジュールと責務

現在の`main.js`内にあるHook script生成、HTTP receiver、provider正規化をそのまま拡張し続けず、ACPに依存しないHook通知境界として分離する。

追加・変更候補:

```text
src/main/hooks/hook-receiver.cjs
  loopback HTTP、token、size limit、schema validation

src/main/hooks/hook-bridge-source.cjs
  provider別allowlist、timeout、配布するbridge source

src/main/agent-events/providers/devin.cjs
  Devin payload → Lifecycle Event

src/notifications/devin-terminal.mjs
  Devin OSC 9 / 777 → Attention Event、dedupe

src/notifications/state.mjs
  promptId、event別dedupe、stale判定、Attention Policy

src/ports/state.cjs
  profile固有hook tokenをport recordへ追加

src/commands/types.js / schemas.js
  sessionId、promptId、stopHookActiveを保持
```

`preload.js`と`renderer.js`には正規化済みeventとSetup statusだけを公開し、raw Devin payload、profile token、設定file内容を渡さない。

Devinのuser-level設定操作は、既存のproject-scoped `hook:setup(projectPath)`と分ける。候補IPCは`devin-hook:status`、`devin-hook:enable`、`devin-hook:disable`とし、rendererから任意pathやcommandを渡さない。

## D-1: 現在のworktree整理

ACP計画やCloud API polling試作を含む現在のdirty worktreeを、Hooks実装前に次へ分類する。

```text
Lifecycle / Attention共通基盤
Devin Cloud API polling試作
Devin Hooks固有実装
既存MCP変更
ローカル .project-mixer 状態
```

共通基盤だけを再利用可能な単位として先に検証・commitする。Cloud polling試作は別commitまたは未採用変更として隔離し、Hooks実装へ混ぜない。既存MCP変更とローカル状態も対象外とする。

### Gate

- Hook receiver、normalizer、Attention Storeの現行責務を記録
- Cloud pollingを残す・破棄する判断をHooks実装から分離
- 対象pathを明示してstage可能
- `npm test`と`npm run build:renderer`の基準結果を保存

---

## D0: Probe

実装前に、機密情報を含まない一時workspaceだけを変更対象とするisolated probeを作る。現在の基準versionは`3000.4.16`だが、実行時に再取得し、versionだけでpayloadを推測しない。

### 収集する情報

- Devin version
- `/hooks`に表示されるHookとsource file
- Hook読み込み状態を非対話で取得できるcommand / flag / config APIの有無
- user / project / imported Claude configの読み込み結果
- 3イベントそれぞれのstdin field名と型
- `session_id`のsession内継続性
- `prompt_id`のturn内継続性、turn間rotation、欠落条件
- `stop_hook_active`の値と変化
- PM環境変数継承
- OSC 9 / 777のpayloadと発火順
- Hook commandの実行順とイベント到着順
- Stop Hookがblockした場合の再開・再発火
- Hook command timeout時のDevin本体の挙動
- receiver停止・port file不在時のDevin本体の挙動
- 通常版とdev profile同時起動時のrouting
- packaged版からbridgeを起動できるruntime方式

### Probeケース

機密情報を含まない一時workspaceで次を実行する。

Lifecycle payload確認には一時workspace内の`.devin/hooks.v1.json`を使い、実projectを変更しない。user-level configを使うpackaged bridge確認は、変更内容の提示、backup、atomic restoreを前提に別ケースとして実行する。

1. `UserPromptSubmit → Stop`の通常完了
2. 1turn中に2回permissionを要求する安全な操作
3. permissionを承認した場合と拒否した場合
4. 別のStop Hookが1回blockした後に完了する操作
5. Stop直後に次のpromptを送る操作
6. 同じcwdで2つのDevin terminalを同時実行
7. receiverを停止した状態でpromptを送信
8. bridgeを意図的にtimeoutさせる
9. 通常版とdev profileを同時起動
10. packaged buildからuser-level Hookを実行

Probe Hookはraw payloadを一時ファイルへ残さず、field名、型、IDの一致関係、時刻、終了codeだけを記録する。prompt、`tool_input`、`tool_response`、token、environment dumpは記録しない。

probe終了時に一時Hook、blocking Hook、bridge、config backupの復元を確認し、user-level設定へ試験entryを残さない。

### 調査結果の記録

以下をprobe結果として残す。

```text
Devin CLI version
OS / shell
読み込まれたHook source
payload field matrix
event ordering matrix
environment継承結果
Stop block共存結果
timeout / receiver停止結果
packaged bridge方式
採用判断とblocker
```

観測事実と設計判断を分ける。公式仕様と実測が異なる場合は実装を進めず、versionと再現手順をblockerとして記録する。

### Gate

Attention経路は以下を満たせば先行実装できる。Hook Bridge固有項目はBridge着手前のGateとして残す。

- 実DevinでOSC `Devin needs input`と`Devin finished`を取得
- 実Devinで`UserPromptSubmit`と`Stop`を取得
- `session_id` / `prompt_id`の相関条件を確認
- PM環境変数から`ptyId`を取得
- 同一cwdの2terminalを正しく区別
- receiver停止とtimeout時にもDevinが継続
- allowlist payloadだけがreceiverへ届く
- packaged版でsystem Node.jsに依存しないbridge方式を確認

---

## D1: Devin Lifecycle Mapper

追加候補:

```text
src/main/agent-events/providers/devin.*
```

担当:

```text
raw Devin hook / terminal OSC
↓
AgentLifecycleEvent
```

Claude/Codex mapperと同一receiverから利用する。

main processのnormalizerは`sessionId`、`promptId`、`stopHookActive`を保持し、command schema、IPC payload、renderer action、Attention Storeまで同じ変更単位で通す。raw Hook payloadは保持しない。

### Gate

fixtureから、

- turn_started
- needs_attention（OSC）
- turn_stop_requested
- turn_completed（OSC）

が生成される。

Stop Hook単独では`turn_completed`へ昇格しない。OSC `Devin finished`だけを完了通知へ変換する。

---

## D2: Routing

PTY runtime生成時に、

```text
PROJECT_MIXER_PTY_ID
```

を注入。

Hook bridgeから`ptyId`を送る。

fallback:

```text
ptyId
↓
sessionId binding
↓
cwd
↓
unattributed
```

### Gate

同一project・同一cwdでDevinを2タブ起動しても通知が交差しない。

無効なprofile token、未知の`ptyId`、終了済みPTYは未帰属として扱い、別terminalへfallbackしない。

---

## D3: Attention統合

既存Storeへ接続。

期待:

```text
OSC needs input
→ amber

OSC finished
→ white

terminalを開く
→ white clear

入力する
→ amber clear
```

amber解除はAttention acknowledgementであり、permission結果の推測ではない。OSCには`promptId`がないため、対象PTYへ直接routingし、Hookのturn相関とは別に扱う。

### Gate

Claude / Codex既存通知の挙動にregressionなし。

---

## D4: Setup UX

Devin Hookが存在しない場合だけ、

```text
Devin notifications are not configured
[Enable]
```

を出す。

自動でproject-levelファイルを書かない。

有効化時は対象設定を既存内容とmergeし、Project Mixerが所有するHookだけ識別可能にする。

アンインストール時にもProject Mixer分だけ削除できるようにする。

user-level `config.json`では既存の未知fieldと既存Hookを保持し、`hooks`配下だけを更新する。parse不能な設定は上書きしない。更新は同一directoryの一時ファイルからatomic replaceし、変更前backupを作る。

Project Mixer所有entryは完全一致するbridge path、`--provider devin`、event名で識別する。任意の独自fieldをDevin設定へ追加しない。

Setup statusには最低限、次を表示する。

```text
bridge executable
user config path
loaded / not loaded
Stop notifications: enabled / disabled by competing hook
last probe version
```

### Gate

- 既存のDevin設定と他者Hookを保持
- Enableを複数回実行しても重複しない
- DisableでProject Mixer所有entryだけを削除
- 通常版・dev profileのどちらから起動しても正しいreceiverへ配送
- packaged版でsystem Node.jsなしに動作

---

## D5: 実利用検証

最低以下を確認。

1. 普通の完了
2. permission待ち
3. permission後の完了
4. 連続2turn
5. Stop直後に次prompt
6. 2つのDevin terminal同時実行
7. 同じcwdの2terminal
8. Devin終了
9. Project Mixer終了
10. Hook receiver停止時
11. 同一turn内のpermission 2回
12. competing Stop Hookがblockする場合
13. invalid token / oversized body
14. app通常版とdev profile同時起動
15. packaged版でのEnable / Disable

Hook receiverが落ちていても、**Devin本体の作業を妨げない**ことを最重要条件とする。

---

# 14. テスト戦略

### Unit

- Devin payload validation
- mapping
- event別dedupe
- OSC 9 / 777の重複除去
- 未知のOSC payloadの無視
- stale prompt判定
- Stop Hookのstale turn相関
- malformed JSON
- missing prompt_id
- missing ptyId
- invalid profile token
- body / stdin size limit
- TTL cache上限とcleanup

### Integration

fake Hook payload:

```text
UserPromptSubmit
Stop
```

をlocalhost receiverへ送信する。加えて、xterm parserへ実測済みのOSC 9 / 777 fixtureを送り、アンバーと白のUI遷移を確認する。

加えて、receiver未起動、応答停止、HTTP timeout、重複Stop、stale Stop、未知PTY、同時2profileを再現する。

### Real CLI

実Devinで、

```text
session_id continuity
prompt_id rotation
event ordering
needs input / finished OSC
blocking Stop Hook interaction
```

を確認。

Devin公式仕様では同一turn内で`prompt_id`が共通だが、**Project Mixer側はイベント到着順が必ず時系列通りとは仮定しない。**

---

# 15. Security / 非阻害原則

Hook bridgeは以下を送らない。

- prompt全文
- tool_input全文
- tool_response全文
- secret
- environment dump

Project Mixerに必要なのは、

```text
provider
eventType
ptyId
sessionId
promptId
stopHookActive
observedAt
```

OSC adapterは既知の固定文言だけを正規化し、raw terminal outputをAttention Storeへ保存しない。

receiverはloopbackだけへbindし、起動時生成tokenを要求する。`port.json`はprofileごとに分離し、可能な範囲で同一OS userだけが読めるpermissionにする。token、raw stdin、promptはlog、IPC、renderer store、crash reportへ出さない。

Hook失敗時:

```text
Devin processing
↓
PM hook error
↓
exit 0
```

を基本とし、Project Mixerの通知機能がDevinの作業をblockしない。

Hook設定の`timeout`とbridge内部timeoutの両方を必須とし、receiverがTCP接続後に応答を返さない場合もDevinを待たせない。

---

# 16. やらないこと

今回の範囲では以下を実装しない。

- ACP Client
- Devin transcript UI
- Devin prompt送信API
- permission自動承認
- Devin tool call表示
- Cloud session pollingとの統合
- project内`.devin/`自動生成
- PTY画面文字列からの完了推測
- LLMによる「質問か完了か」分類
- competing Stop Hookがある状態での完了推測

---

# 17. Commit境界

1. `docs: plan Devin lifecycle hook notifications`
2. `refactor(v2): isolate agent lifecycle notification foundation`
3. Cloud polling試作を残す場合のみ独立した`feat(v2)` commit
4. `test(v2): probe Devin lifecycle hooks and terminal signals`
5. `refactor(v2): harden the local hook bridge and receiver`
6. `refactor(v2): normalize Devin lifecycle hook events`
7. `feat(v2): route Devin hooks to terminal runtime`
8. `feat(v2): show Devin OSC attention notifications`
9. `feat(v2): add Devin hook setup`
10. `test(v2): verify concurrent Devin notifications`

各commitでは対象pathだけをstageし、既存MCP変更、ACP計画、ローカル`.project-mixer/`状態を混ぜない。

---

# 完了条件

以下が成立したらDevin Hooks統合完了とする。

```text
Devin TUIをそのまま利用できる

+

UserPromptSubmit
OSC needs input
OSC finished
Stop correlation

↓

Project Mixerが正しいterminalへ通知

↓

amber / whiteが既存Claude/Codexと同じUXで動く
```

特に、

> **Hookが壊れてもDevinは壊れない**

を必須条件とする。

さらに、複数permissionを落とさず、競合Stop Hookによる偽の完了通知を出さず、通常版とdev profileを同時起動しても通知先が交差しないことを必須とする。

この統合ではDevinをProject Mixerの管理下へ移さず、**Devin自身のTUIを維持したままLifecycle情報だけを翻訳する。**

---

# 参考仕様と再確認

2026-08-13時点の基準資料:

- [Devin CLI Hooks](https://docs.devin.ai/cli/extensibility/hooks/overview)
- [Devin CLI Lifecycle Hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)
- [Devin CLI Configuration Import](https://docs.devin.ai/cli/reference/configuration/read-config-from)
- [Devin CLI Configuration Precedence](https://docs.devin.ai/cli/reference/configuration/global-vs-local)

Devin CLI updateでHook event、payload、設定場所、exit code、timeout semanticsが変わり得る。実装開始時とrelease前に、現在versionの公式仕様とD0 probeを再実行する。
