# Devin ACP 統合計画

**作成日**: 2026-08-13
**状態**: 提案
**対象**: Project Mixer v2 / Devin統合

## 結論

DevinはCloud APIへの手動Session ID紐づけではなく、Project Mixerが `devin acp` のACP Clientとなり、セッション生成・入力・承認・キャンセル・終了を扱う。

`session/new` で得たACP Session IDをProject Mixerのタブへ自動紐づけし、Devin ACPタブでは手入力Session IDを不要にする。

ただし、ACP統合成功を理由にCloud API monitoringを即時削除しない。ACP SessionとCloud Devin Sessionは別identityとして扱い、現在のworktree上のCloud API polling試作が担っているユースケースがACP経路で不要になったことを確認してから削除する。

Project Mixer独自の `AgentAdapter` は作らない。

共通化するのは以下に限定する。

* ACP transport / protocol handling
* Agentから受け取ったLifecycle Event
* 人間に提示するAttention State

Claude / CodexのRaw TUIと、DevinのACP interfaceは別の実行方式として扱う。

---

## 設計原則

### 1. Agent独自の抽象化を作らない

従来のD2「エージェントを一切抽象化しない」は、以下のように精密化する。

> **Project Mixer独自のAgent abstractionを作らない。Agentが正式に提供する標準interfaceは、その形を保ったまま利用してよい。**

したがって、

```text
Claude / Codex
→ Raw PTY / TUI

Devin
→ ACP
```

とする。

ACPを利用すること自体はAgentをProject Mixer独自形式へ置き換えることではない。

---

### 2. Raw transportと人間向け表示を分離する

```text
Devin ACP
   ↓
ACP Protocol Model
   ↓
Project Mixer Lifecycle Event
   ↓
Attention State / Transcript UI
```

ACP messageをそのままrenderer stateへ流さない。

Protocol固有情報はmain process内に閉じ、人間向け状態へ変換する。

---

### 3. Client Capabilityは最小権限から開始する

Project MixerがACP Clientになったからといって、AgentへすべてのClient Capabilityを提供しない。

初期状態では、

```text
filesystem capability: 提供しない
terminal capability: 提供しない
その他 optional capability: 必要なものだけ
```

とする。

Devinが自身の実行環境を持つ前提を崩さない。

A0で、filesystem / terminal capabilityをProject Mixerから提供しなくても実用的な1ターンを完了できるか確認する。

必要だった場合は、それを単なる実装詳細ではなく別の設計判断として扱う。

---

## 目標アーキテクチャ

```text
Scratch / Permission UI
          |
    validated Command
          |
   ACP Session Service
          |
   ┌──────┴───────────────┐
   |                      |
ACP Protocol          Lifecycle Mapper
   |                      |
DevinAcpLauncher       AgentLifecycleEvent
   |                      |
devin acp              Attention Store
(stdio)
```

### AcpSessionService

以下を所有する。

* initialize
* protocol negotiation
* authentication
* session/new
* session/prompt
* session/cancel
* permission response
* capability確認
* session close
* process teardown

### DevinAcpLauncher

以下だけを所有する。

* executable path
* CLI arguments
* environment
* subprocess起動
* stdin/stdout/stderr handle

ACP protocol処理は持たない。

### Runtime Registry

main processのruntime registryのみが、

* process handle
* stream handle
* ACP connection
* runtimeId

を保持する。

rendererにはNode processやstreamを出さない。

### Renderer Store

保持するのは最低限。

```ts
{
  runtimeId,
  provider: "devin",
  transport: "acp",
  sessionId,
  status,
  displayName
}
```

ACP Session IDとCloud APIの `devin-...` IDは別identityとして扱う。

相互変換を推測しない。

---

# A-1: 現在の通知実装を整理

A0へ進む前に、現在のdirty worktreeにある通知関連変更を棚卸しする。

対象を少なくとも以下へ分ける。

```text
Lifecycle / Attention基盤
Devin Cloud API polling試作
通知UI / Store
既存MCP変更
ローカル .project-mixer 状態
```

Lifecycle / Attention基盤はDevin ACPから再利用できる単位へ分離し、単独で検証・commitする。

Cloud API polling試作は別commitまたは未採用変更として隔離し、ACP実装と同じcommitへ混ぜない。既存MCP変更やローカル `.project-mixer/` 状態も対象外とする。

### Gate

* ACPが依存するLifecycle / Attention基盤の責務と所有先が明確
* Cloud pollingを残す・置換する判断をACP実装から独立して行える
* 対象pathを明示してstageできる
* A0開始時点のbuild / test結果を記録済み

---

# A0: Protocol Probeと基準線

本実装前に、独立したprobeを作る。

## SDK / Module境界

JSON-RPC transportは公式 `@agentclientprotocol/sdk`を利用し、framing、request ID管理、protocol型を独自実装しない。

A0で実Devinとの接続を確認できたSDK versionを完全固定する。`package.json`では `^` / `~` を付けず、lockfileと合わせて基準線にする。

公式SDKはESMであり、Project Mixerのmain processと既存serviceはCommonJSであるため、境界を1か所に限定する。

候補:

* ACP serviceを `.mjs` として実装する
* CommonJS側の単一adapterから `import()`する

採用方式はA0 probeで起動、例外伝播、shutdownを確認してから決める。rendererや他のCommonJS moduleへESM対応を波及させない。

## 確認項目

`devin acp`を起動し、以下を順に試す。

```text
initialize
↓
protocol version negotiation
↓
agentInfo
↓
capabilities
↓
authMethods
↓
必要ならauthenticate
↓
session/new
↓
session/prompt
↓
session/update
↓
permission request
↓
prompt response
```

以下を記録する。

* negotiated protocol version
* agentInfo name / version
* Agent capabilities
* Client capabilities要求
* authMethods
* session/new response
* ACP Session ID形式
* permission requestの構造
* prompt responseの `stopReason`
* session/updateの種類
* stderrの出力傾向
* process終了時の挙動
* `session/new`で受理されるMCP server transport
* session/list / resume / close capability

SDK versionだけで互換性を判断せず、**実際にnegotiationされたprotocolVersionとcapabilityを基準線として保存する。**

初版の対応versionはstable v1の明示allowlistとする。将来versionを追加する場合も、SDK versionから推測せずnegotiation結果を検証して許可する。

## Capability Probe

特に以下を確認する。

```text
filesystem capabilityなし
terminal capabilityなし
```

でもDevinが正常に作業できるか。

これが成立しない場合、本実装へ進む前に設計を再評価する。

## Authentication Probe

既存のDevin CLI login stateが `devin acp` から利用されるかを確認する。

認証を暗黙に仮定しない。

## Handoff Probe

可能なら `/handoff` 相当のcloud移行がACP利用時にどう見えるかを確認する。

確認項目:

* ACP sessionが継続するか
* Cloud Devin Session IDが取得できるか
* ACPからcloud session statusが見えるか
* Project Mixer側で別runtimeとして扱う必要があるか

## Logging

ログへ残してよいもの:

* protocol version
* message method
* request ID
* capability
* timing
* stopReason
* error code

残さないもの:

* prompt全文
* token
* environment secrets
* permission payload内の秘密値
* Agent response本文

### Gate

以下を満たすまでA1へ進まない。

* 実Devinで1ターン完了
* ACP Session ID自動取得
* Project Mixerが許可するstable protocol version（初版はv1）のnegotiation成功
* authentication方式確認
* permission経路の実測または、発生しない条件とAgentの挙動を記録
* terminal stop reason（少なくとも `end_turn`）取得
* cancel時の `cancelled` 相当挙動確認
* filesystem / terminal capability要否確認
* subprocess終了時の挙動確認

permission確認には、専用の一時workspaceで安全なread-only操作と、承認が必要になり得る限定操作を使う。Devin側のpolicyで自動承認される場合は、それ自体を観測結果として記録し、permission requestが発生しないことだけをblockerにしない。

その他が成立しない場合は実装せずblockerとして記録する。

---

# A1: Main ProcessのACP境界

追加候補:

```text
src/main/acp/acp-session-service.*
src/main/acp/acp-runtime-registry.*
src/main/agents/devin-acp-launcher.*
```

## 初期構成

**1 tab = 1 subprocess = 1 ACP session**

から始める。

理由:

* crash isolation
* permission attribution
* teardown
* routing
* logging
* debugging

が単純になるため。

1 processで複数sessionを持つ構成は実測後に再検討する。

## Renderer IPC

rendererからmainへのcommand IPCは限定する。

```text
acp:create
acp:prompt
acp:cancel
acp:permission-response
acp:close
```

mainからrendererへは、生のACP messageではなく型付きのProject Mixer eventだけを送る。

```text
acp:runtime-state
acp:turn-event
acp:permission-request
acp:transcript-event
acp:error
```

`session/prompt`のprotocol responseはターン終了までpendingになり得る。`acp:prompt`は長時間のinvoke完了をUI状態遷移に使わず、入力受理後すぐ `{ runtimeId, turnId }` を返し、stream、完了、失敗はeventで通知する。main processが長時間のprompt requestを所有する。

request / responseの相関はmain processで管理する。

```ts
type PendingPermissionKey = {
  runtimeId: string;
  requestId: string;
};
```

`acp:permission-response`は `runtimeId`、`requestId`、`optionId` を必須とし、pending requestをatomicに一度だけ消費する。cancel、tab close、process exit時は該当runtimeのpending requestを解放し、stale responseを拒否する。

必要なら、

```text
acp:resume
```

を後から追加する。

protocol messageそのものをrendererへ送らない。

## Renderer Runtime境界

現在のrenderer tabは `terminal`、`fitAddon`、`ptyId`、`termEl` を常に持つ前提である。ACP Agent Viewを追加する前に、この前提を判別可能なruntimeへ分離する。

```ts
type TabRuntime =
  | {
      kind: 'terminal';
      terminal: Terminal;
      fitAddon: FitAddon;
      ptyId: string;
      termEl: HTMLElement;
    }
  | {
      kind: 'acp';
      runtimeId: string;
      sessionId: string;
      viewEl: HTMLElement;
    };
```

切替、送信、resize、close、focus、project切替はruntime controllerへ委譲する。A3で各既存関数へACP条件分岐を追加し続けない。

これは `REFACTORING_PLAN.md` のR3/R4に残るrenderer controller分離を、ACPに必要な範囲で先行完了する作業として扱う。

## cwd / Project

`cwd` と `projectId` はProject Mixerが明示的に渡す。

cwdからrouting先を推測しない。

```text
projectId
runtimeId
ACP sessionId
```

を登録時に結び付ける。

## Error handling

以下を明示的なResultへ変換する。

* timeout
* malformed JSON-RPC
* unsupported protocol version
* authentication failure
* unexpected process exit
* permission response error
* session not found
* unsupported capability

## Shutdown

ACPのoptional capabilityとruntime終了を分ける。

概念的には、

```text
session/close 対応
→ session/close
→ process terminate

session/close 非対応
→ 必要ならsession/cancel
→ response待機
→ process terminate
```

とする。

`session/close`を常に使える前提にしない。

### Gate

fake ACP childとrenderer runtime controllerのtestを使い、実Devinなしで以下を再現する。

* normal completion
* permission
* cancel
* malformed response
* process crash
* timeout
* concurrent 2 runtime
* close中のresponse
* unknown notification
* terminal tabとACP tabの切替、送信、close
* pending permissionの重複・別runtime・stale応答拒否
* prompt受理後もcancelとtab操作が可能

---

# A2: Lifecycle Event正規化

既存のAgent通知modelへACPを接続する。

Protocol EventとAttention Eventを直接同一視しない。

## Lifecycle model

候補:

```ts
type AgentLifecycleEvent =
  | {
      kind: "turn_started"
      runtimeId: string
      sessionId: string
    }
  | {
      kind: "needs_attention"
      reason: "approval" | "input"
      runtimeId: string
      sessionId: string
    }
  | {
      kind: "turn_completed"
      runtimeId: string
      sessionId: string
      stopReason: string
    }
  | {
      kind: "turn_stopped"
      runtimeId: string
      sessionId: string
      stopReason: string
    }
  | {
      kind: "turn_failed"
      runtimeId: string
      sessionId: string
      error: NormalizedAgentError
    }
```

## StopReason mapping

ACPの意味を失わず保持する。

```text
end_turn
→ turn_completed
→ 白通知候補

cancelled
→ turn_stopped
→ 通知なし

max_tokens
→ turn_stopped
→ 警告候補

max_turn_requests
→ turn_stopped
→ 警告候補

refusal
→ turn_stopped
→ 警告候補
```

`turn_completed`と`turn_failed`だけへ無理に潰さない。

`turn_stopped`追加時は型定義だけで終わらせず、command schema、state summarizer、attention store、tab / project status表示も同じ変更単位で更新する。`max_tokens`、`max_turn_requests`、`refusal`の警告状態は、次のturn開始または明示dismissまで失わない。

## Permission

`session/request_permission`は、

```text
needs_attention(reason: approval)
```

へ変換する。

自動承認しない。

Permission解除はACP responseが成功した時点で行う。

## Priority

イベントの信頼度:

```text
Native ACP
   ↓
Agent Hook / Plugin
   ↓
Structured terminal signal
   ↓
PTY heuristic
```

ACP runtimeではPTY heuristicを原則使用しない。

### Gate

* 同時2runtimeでroutingが交差しない
* duplicate notificationでbadgeが増殖しない
* cancel後に白通知が出ない
* permission解除前にamberが消えない
* stale responseが別turnへ適用されない

---

# A3a: Devin ACP 最小Vertical Slice

まずRich Agent UIを作らず、日常利用可能な最小経路を成立させる。

## New Tab

New Terminal / New Sessionメニューに、

```text
Devin (ACP)
```

を追加。

選択時に、

```text
subprocess起動
↓
initialize
↓
session/new
↓
タブ紐付け
```

まで自動実行する。

Session ID入力欄は置かない。

## View

ACP stdoutはprotocol専用。

xterm.jsへ流さない。

中央には専用Agent Viewを表示する。

初版では表示対象を絞る。

```text
User message
Assistant text
Permission request
Status
Error
```

だけ。

tool call、plan、diff等は最初から完全表示しない。

## Scratch

Scratch送信を、

```text
session/prompt
```

へ接続する。

送信前の既存Project Mixer context assemblyは維持する。

## Permission

Permission Modalでは、

* tool title
* tool概要
* Agent提示option

を表示する。

Agentへ返す値は、Agentが提示した `optionId` のみとする。

Project Mixer内部のIPC envelopeには、誤配送防止のため `runtimeId` と `requestId` も必須で含める。rendererは複数runtimeから届くpermissionをqueueし、表示中のrequestと応答先を一致させる。

Project Mixer独自の、

```text
always allow this tool
always allow this project
```

等は作らない。

## Cancel

Cancelは、

```text
session/cancel
```

へ接続する。

cancelled turnには完了通知を出さない。

### Gate

以下を連続操作できる。

```text
New Devin ACP
↓
Prompt
↓
Streamed response
↓
Permission
↓
Continue
↓
Completion
↓
Second prompt
↓
Cancel
↓
Tab close
```

手入力Session IDなしで完結する。

---

# A3b: Rich Transcript

A3aの日常利用が成立してから追加する。

対象候補:

* tool_call
* tool_call_update
* plan
* locations
* diff
* thought
* richer error presentation

ACP message modelをすべて独自UI化することを目的にしない。

**実際に人間が見る必要がある情報から追加する。**

Agent Viewが独自IDEへ成長しないように注意する。

---

# A4: MCP / Shared View連携

ACP `session/new`でMCP server情報を渡せる場合、Devin ACPではProject Mixer Shared Viewをsession-specificに渡す構成を検討する。

候補:

```text
Project Mixer
↓ session/new

mcpServers:
  Project Mixer Shared View
```

これが成立する場合、

* `.mcp.json`を変更しない
* Devin global configを変更しない
* `devin mcp add`を要求しない

構成にできる。

A0で、`session/new`へ渡せるMCP server transportとDevin側の受理結果を記録する。

```text
stdio support
http support
unsupported transport時のerror
```

`mcpCapabilities`というadvertise項目が存在すると仮定せず、negotiated capabilityと実際の `session/new` request / responseを基準に判定する。

ただしShared View統合はDevin ACP vertical sliceの必須条件にはしない。

---

# A5: Persistence / Resume

初版は新規sessionのみ。

`session/list` / `session/resume`はcapability確認後に追加する。

## Layout保存

保存する候補:

```text
provider: devin
transport: acp
sessionId
cwd
displayName
```

保存しない:

* process handle
* authentication secret
* prompt全文
* permission secret
* transport internals

## App Restart

再起動時:

### resume対応

```text
session/resume
↓
既存tab復元
```

### resume非対応

```text
以前のsessionは復元不可
↓
UIで明示
↓
新規session開始
```

黙って新規sessionとして既存tabへ接続しない。

### Gate

* app restart
* concurrent 2 profiles
* different projects
* same cwd multiple runtimes

でidentityが交差しない。

---

# A6: Cloud API Monitoringの再評価

ACP統合成功だけではCloud API pollingを削除しない。

以下を個別に評価する。

現在Cloud API monitoringが担当しているもの:

* cloud session status
* waiting_for_user
* waiting_for_approval
* finished
* handoff後の状態
* cloud-origin session

ACPで代替できるものとできないものを分類する。

## 削除条件

以下が成立した場合のみ、

```text
DevinSessionMonitor
DEVIN_API_TOKEN
DEVIN_ORG_ID
Bind / Unbind UI
```

を削除する。

> **Project Mixerで実際に利用しているCloud API monitoringの全ユースケースがACP経路または不要化によって代替された。**

単に、

> Devin ACPで1turn動いた

ことを削除条件にしない。

Cloud Sessionが独立した価値を持つ場合は、

```text
Local Devin ACP Runtime
Cloud Devin Session
```

として別modelで保持する。

---

# A7: Legacy移行

`Devin (ACP)`を既定へ移す。

PTY型Devin CLIについては、ACP実利用を確認してから判断する。

## 推奨

最低1 releaseは、

```text
Devin
Devin CLI (legacy)
```

として残す。

理由:

* ACP固有の退行確認
* resume不足
* handoff差分
* authentication問題
* Devin CLI updateによるprotocol regression

の逃げ道になるため。

ACP版が日常利用で安定した後にlegacy削除を判断する。

---

# A8: 統合検証

## Unit

* SDK adapterの入力 / 出力変換
* runtime / turn / permissionの相関
* capability negotiation
* authentication state
* event mapping
* stopReason mapping
* redaction
* teardown

## Contract

fake stdio Agentで、

* permission
* text stream
* out-of-order notification
* unknown message
* cancel
* process crash
* duplicate / stale permission response
* prompt中の別runtime操作

を再現する。

未知のnotificationはfail-safeに無視し、requestで理解不能なものは明示errorを返す。

## Integration

installed `devin acp`と、

* initialize
* authentication
* session/new
* 1 turn
* permission
* cancel

を確認する。

## Electron

* project routing
* tab routing
* unread state
* attention badge
* focus非奪取
* close時process回収
* window close
* simultaneous 2 runtime

を確認する。

## Security

以下へsecretを残さない。

* stdout log
* stderr log
* toast
* renderer store
* layout
* debug trace
* crash report

特に、

* access token
* prompt全文
* permission payloadの秘密値
* environment secret

をredactする。

---

# Commit境界

1. `docs: plan Devin ACP integration`
2. `refactor(v2): isolate agent lifecycle notification foundation`
3. Cloud polling試作を残す場合のみ、独立した `feat(v2)` commit
4. `test(v2): probe Devin ACP protocol and capabilities`
5. `refactor(v2): add ACP SDK and runtime service boundary`
6. `refactor(v2): separate terminal and ACP tab runtimes`
7. `feat(v2): add Devin ACP lifecycle integration`
8. `feat(v2): add minimal Devin ACP agent view`
9. `feat(v2): add Devin ACP permission flow`
10. `feat(v2): persist and resume Devin ACP sessions`
11. `refactor(v2): retire obsolete Devin cloud polling`
12. `test(v2): verify Devin ACP lifecycle in Electron`

Cloud polling削除commitは、削除条件を満たした場合のみ作る。

既存MCP変更やローカル `.project-mixer/` 状態は混ぜず、各commitで対象pathだけをstageする。

---

# 未決事項

## 1. Legacy Devin CLI

候補:

* ACP完成時に即削除
* 1 release残す

**推奨: 1 release残す。**

---

## 2. ACP View

候補:

* terminal風UI
* 専用Agent View

**推奨: 専用Agent View。**

ただし見た目の密度、フォント、キーボード操作はterminalに寄せてもよい。

PTYとACPを同じ技術的surfaceとして偽装しない。

---

## 3. Resume

候補:

* 初回releaseへ含める
* vertical slice後

**推奨: vertical slice後。**

まず、

```text
new → prompt → permission → complete → cancel
```

を完成させる。

---

## 4. Permission Scope

Agentが提示するoptionをそのまま表示する。

Project Mixer独自のpermission policyを作らない。

---

## 5. Client Capability

A0で最優先確認。

Project Mixerがfilesystem / terminal capabilityをadvertiseせずにDevinが実用可能なら、その構成を維持する。

必要だった場合は別decisionとして検討する。

---

## 6. Cloud Handoff

ACP sessionとCloud Devin Sessionがどう接続されるかは推測しない。

A0で観測し、必要なら別identityとして扱う。

---

# 文書更新

方針承認後、以下を更新する。

* `IMPLEMENTATION_PLAN_v2.md`
* `REFACTORING_PLAN.md`
* Project Mixer decisions
* Project Mixer architecture
* ACP除外に関する旧記述

D2は次の意味へ更新する。

> **Project Mixer独自のAgent abstractionは作らない。Raw TUI型AgentはRaw TUIを維持し、ACP等のAgentが正式提供する標準Client interfaceは、その標準を保ったまま利用する。**

---

# 最終Gate

Devin ACPを既定経路へ昇格する条件:

* 10分以上の実作業で日常利用可能
* 2つ以上の同時Devin sessionでrouting正常
* permission正常
* cancel正常
* Agent crashから復帰可能
* tab/window closeでprocess leakなし
* prompt全文やtokenがlog/storeへ漏れない
* Raw CLI版より明確に操作負荷が低い
* Cloud sessionを失う退行がない

これを満たすまではlegacy経路を削除しない。
