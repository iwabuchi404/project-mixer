# Project Mixer 構造リファクタリング計画

**作成日**: 2026-08-12

**状態**: R0実装、R1概ね完了、R2–R4部分実装（2026-08-12）。R5の実Electron検証は未実施。下記「実装ログ」参照。

**対象ブランチ**: `v2`

## 目的

今後の機能追加で `renderer.js` と `main.js` の責務混在を増やさず、状態・通知・コマンド・永続化の正しさを保てる構造にする。全面書き換えやUIフレームワーク移行は行わず、既存動作を維持したまま段階的に境界を引く。

## 現在の基準線

- `renderer.js`: 3,847行。UI、状態、terminal、preview、tab、通知、layoutを所有
- `main.js`: 812行。Electron lifecycle、PTY、hook、MCP起動、永続化、filesystem、menuを所有
- `npm test`: 51件成功
- `npm run build:renderer`: 成功
- 実Electronの `test/phase4-ui-check.cjs` は通常テストに含まれず、今回のレビューでは未実行
- 既存の未コミット差分 `src/mcp/launch.cjs` / `test/phase3.test.cjs`、`.project-mixer/`、`test.text` は本計画のコミットに含めない

## 確認済みの方針

1. Electron、xterm.js、単一 `<webview>`、現行の生DOM UIを維持する。
2. Vue、CodeMirror、状態管理ライブラリの導入を本リファクタリングの目的にしない。
3. 状態変更はCommandを唯一の入口とし、UI・menu・MCPで同じ経路を使う。
4. DOM、xterm、webviewなどのruntime handleをserializableな状態に入れない。
5. IDを推測するfallbackは行わない。配送先が曖昧なら明示的に失敗または未帰属として扱う。
6. 各段階で現行アプリを起動可能にし、big-bang置換を避ける。

## 解決する問題

| ID | 問題 | 影響 |
|---|---|---|
| S1 | rendererのglobal状態と`src/store`が二重管理 | focus、tab、project切替の不整合 |
| S2 | badge / project statusがDOMだけに存在 | 再描画で未確認通知が消える |
| C1 | Commandの引数定義が検証されず、未登録・二重登録がfail-open | 誤った操作が静かに無視・上書きされる |
| H1 | hookのport走査とactive project fallbackが配送先を推測 | 別profile・別tabへの誤通知 |
| P1 | JSON parse失敗を初期値として扱い、非atomic保存する | 設定破損後の上書き・データ消失 |
| R1 | editor / preview / browser / terminalでtab生成を重複 | 新しいtab種別追加時のdrift |
| T1 | 静的ソース検査が多く、状態遷移の回帰検出が弱い | テスト成功でも実UI不整合が残る |

## 目標アーキテクチャ

```text
UI events ─┐
Menu      ─┼─> validated Command ─> Store ─> View subscriptions
MCP       ─┘                            │
                                        └─> runtime registries
                                             (xterm / DOM / webview)

Preload IPC ─> IPC adapter ─> main service ─> explicit Result
                              (PTY / Hook / Config / Files)
```

提案する配置は以下。ファイル名は実装時に調整してよいが、依存方向は維持する。

```text
src/
  commands/
    definitions.js
    registry.js
    handlers/
  state/
    workspace-store.js
    selectors.js
  renderer/
    controllers/   # project, tabs, terminal, preview, scratch
    views/         # DOM生成と描画
    runtime/       # xterm/webview handle registry
  main/
    services/      # config, pty, hook, files
    ipc/           # preload向けchannel登録
  mcp/             # 現行構造を維持
```

## 段階的な実装

### R0: Characterization testを追加

本番コードを動かす前に、現在守る動作と直すべき誤動作をテストへ固定する。

- project A/Bを切り替えてeditor、preview、terminal、scratchが復元される
- 別projectのagent badgeが一覧再描画後も残り、対象projectを見た時だけ消える
- waiting通知が特定PTYだけへ届き、曖昧な通知は他tabへ波及しない
- 破損した`projects.json` / `layout.json`を上書きしない
- Commandの未登録dispatch、二重register、不正argsが失敗する
- preview切替競合、terminalの0寸法、bottom-followを維持する

**Gate**: 新規テストが現状の既知不具合を再現し、それ以外の既存テストが成功する。

**Commit例**: `test(v2): capture refactoring boundaries`

### R1: Fail-open処理と誤配送を修正

- Command registryを未登録・二重登録時にthrowさせる
- `COMMAND_TYPES`を実行時validatorとして使うか、validatorを別定義してCommand入口で検証する
- mainからrendererへのdispatch失敗を呼び出し元へ返す
- hookは`PROJECT_MIXER_PORT_FILE`を正規経路とし、default/devの先着port走査を廃止する
- `ptyId`、明示`tabId`、一意なproject/cwdの順に配送し、複数候補では配送しない
- `command:check`の`--version` shell fallbackを削除または固定コマンドだけに制限する

**Gate**: installed/devを同時起動し、それぞれが生成した新規terminalの通知とMCPが正しいprofileだけへ届く。

**Commit例**: `fix(v2): make command and hook routing fail closed`

### R2: Storeを実際のsingle source of truthにする

まずagent通知と人間の注意状態だけを移し、全UI状態を一度に移さない。

- `activeProjectId`、active main tab、active terminal、editor/preview attentionをstoreへ移す
- projectごとのscratch、open file identity、active preview identityをstoreで保持する
- project badgeとwaiting summaryを状態として保持する
- selectorで`get_focus`、project status、status barを生成する
- `store.subscribe()`からproject list、tab選択、status barを再描画する
- renderer globalへの直接代入を段階的に削除する

StoreにはID・文字列・boolean・配列・plain objectだけを置く。DOM node、`Terminal`、`FitAddon`、Promiseはruntime registryへ置く。

**Gate**: storeの状態だけからbadge/status/focusを再描画でき、project list再生成で状態が失われない。

**Commit例**: `refactor(v2): make workspace attention state authoritative`

### R3: Rendererの責務をfeature単位に抽出

- `tab-view`: 共通markup、選択、close、middle-click、context menu
- `terminal-controller`: create/write/resize/dispose/pasteとruntime registry
- `preview-controller`: preview identity、単一webview、load cancellation、scroll復元
- `project-controller`: project切替、tree読込、project別状態
- `scratch-controller`: content、send、undo、selection

最初に共通基底クラスを作らず、現在3回以上重複しているtab操作だけを小さな関数へ抽出する。terminalとwebviewのmount方式は共通化しない。

**Gate**: `renderer.js`が初期化とcomposition中心になり、各controllerをDOM全体なしで単体テストできる。

**Commit例**: `refactor(v2): extract renderer tab and runtime controllers`

### R4: Main processをserviceとIPC adapterへ分離

- `config-service`: parse、schema確認、backup、atomic write
- `pty-service`: PTY lifecycleとMCP token revokeを一箇所で管理
- `hook-service`: HTTP server、hook設定、厳密なrouting
- `file-service`: read/write/create/deleteと明示的なerror result
- IPC handlerは入力検証とservice呼び出しだけにする
- `src/ports/state.cjs`のatomic JSON処理を汎用persistence helperへ移す

全IPCの戻り値を `{ ok: true, value } | { ok: false, code, message }` に寄せる。キャンセルはerrorと区別する。

**Gate**: main serviceをElectron起動なしでテストでき、破損設定・PTY終了・hook bind失敗を再現できる。

**Commit例**: `refactor(v2): split main process services from ipc`

### R5: 統合検証と文書の現在地更新

- `npm test`
- `npm run build:renderer`
- `node test/phase4-ui-check.cjs <debug-port>`
- installed/dev同時起動、各profileで新規terminalを作成
- Claude/Codex MCPの`get_focus`と`show_file`
- project A/B間のtab・scratch・preview復元
- agent badge、waiting、line reveal、preview scroll復元
- clean checkoutまたはcommit基準のcheckoutでbuild/testを再実行
- `IMPLEMENTATION_PLAN_v2.md`のPhase 4「次」表記など、現状とずれた記述を修正する

**Gate**: 自動テストだけでなく、上記実Electron操作の結果を記録できる。

**Commit例**: `docs: record refactoring completion and runtime checks`

## 機能追加とのゲート

| 機能 | 先に必要な段階 |
|---|---|
| agent状態・hook通知の追加 | R0–R2 |
| kamox / 新しいbrowser・preview tab | R0–R3 |
| Git状態表示 | R0–R2、main側処理を増やすならR4 |
| 直近terminal出力の送信 | R0–R2。terminal抽出と同時ならR3 |
| 小さな局所UI修正 | 回帰テストを追加できる場合は並行可 |

## 対象外

- Vue、React等への移行
- xterm.jsまたは`<webview>`の置換
- MCP transportの再設計
- Git差分viewer、ACP client、OSC 133
- 使われる前の汎用component framework
- UIデザインの再変更

## 決定事項

2026-08-12にユーザー確認により確定。これらは`decisions/`へ記録する前提だが、Project MixerのAI Cortexページが未作成のため、まず本計画書に記載し、ページ作成後に移譲する。

1. **配送先不明のhook通知**: 未帰属のpersistent noticeとして表示する。誤配送は防ぎつつ、ユーザーが通知を見逃さないようにする。R1で未帰属通知のUI状態を追加する。
2. **破損設定の起動挙動**: 起動を止める。エラーを表示して中断し、既存データの自動上書きを防ぐ。R4のconfig-serviceで実装する。
3. **Command argsのvalidator**: Zodを導入する。`dependencies`へ追加し、`COMMAND_TYPES`をZod schemaから生成するか、schemaを別定義してCommand入口で検証する。
4. **機能追加再開条件**: R2完了を必須とする。R1完了後も局所機能追加は許可せず、attention/badge/waiting状態が一箇所に集約されるまで機能追加を保留する。

## 未決事項

実装前にユーザー確認が必要だった項目は上記「決定事項」へ移動した。現時点で新たな未決事項なし。

## 完了条件

- attention、badge、waitingのauthoritative stateが一箇所にある
- UI、menu、MCPの状態変更が同じvalidated Commandを通る
- 曖昧なfallbackでprofile/project/tabを推測しない
- 設定破損時に既存データを自動上書きしない
- renderer/mainの各抽出先が単独テスト可能
- 51件の既存テスト、新規回帰テスト、build、実Electron検証が成功
- 既存の単一webview、terminal復元、focus preservationを維持する

## 実装ログ

2026-08-12にR0を実装し、R1–R4の一部を実装。`npm test` と `npm run build:renderer` を確認したが、各段階のGateをすべて満たした状態ではない。

### R0: Characterization test
- `test/refactor-r0.test.cjs` を追加（27件）。KNOWN-BUG（R1/R2/R4で修正対象）とKEEP（維持すべき動作）を分離。
- Gate: 既存51件 + 新規27件 = 78件成功。

### R1: Fail-open処理と誤配送を修正（概ね完了）
- `src/commands/schemas.js` を新規作成。Zod 4.4.3を導入し、全25コマンドのargs schemaを定義。
- `src/commands/registry.js`: register()の二重登録をthrow、dispatch()の未登録handlerをthrow、argsをZodで検証。
- `main.js` `handleHookNotification`: cwd一致が複数PTYで曖昧な場合は配送せず `ambiguous` フラグを送信。
- `main.js` HOOK_SCRIPT: `PROJECT_MIXER_PORT_FILE` env varのみを使用し、userData走査fallbackを削除。
- `main.js` `command:check`: `--version` fallbackをclaude/codexのみに制限。
- `renderer.js` `onHookNotify`: activeProjectId fan-outを削除、未帰属通知をpersistent toastとして表示。
- `main.js` `dispatchToRenderer`: エラーを握り潰さずlog出力してre-throw。
- Gate: 自動テスト成功。installed/dev同時起動による配送確認はR5で必要。

### R2: Storeをsingle source of truthに（部分実装）
- `src/store/index.js`: `projectBadges` と `waitingTabs` を追加。selector `getProjectBadge`/`getWaitingSummary`/`isTabWaiting` を追加。
- `renderer.js` `project_set_badge` handler: storeを更新し、DOMはstoreから描画。
- `renderer.js` `renderProjectList`: 再描画後にstoreからbadge/waiting状態を復元。
- `renderer.js` `updateTabStatus`/`updateProjectStatus`: storeと同期。
- `renderer.js` `closeTerminal`: storeからwaiting状態を削除。
- **残作業**: `activeProjectId`、active file/preview/terminal、project別scratch/open file identityはrenderer globalとの二重管理が残る。store subscriptionによる描画も未導入。
- Gate: badge/waitingの自動テスト成功。R2全体のGateは未達。

### R3: Rendererの責務をfeature単位に抽出（部分実装）
- `renderer.js` `createMainTab` factoryを追加。4種類のtab（preview/browser/file/terminal）の重複markup + event setupを統合。
- 共通基底クラスは作成せず、terminalとwebviewのmount方式は共通化しない（計画通り）。
- **残作業**: terminal / preview / project / scratch controllerとruntime registryの抽出。`renderer.js`は引き続きcomposition以外の責務を持つ。
- Gate: tab factoryの自動テスト + build成功。R3全体のGateは未達。

### R4: Main processをserviceとIPC adapterへ分離（部分実装）
- `src/main/config-service.cjs` を新規作成。`readConfig`/`writeConfig`/`validateProjects`/`validateLayout`/`ConfigParseError`。
- `main.js`: `loadJson`/`saveJson`を廃止、`loadProjectsConfig`/`saveProjectsConfig`/`loadLayoutConfig`/`saveLayoutConfig`に置き換え。
- `main.js`: 起動時にprojects.jsonが破損している場合はerror dialogを表示してquit（決定事項2）。
- `test/refactor-r4.test.cjs` を追加（10件）。config-serviceをElectron起動なしでテスト。
- Gate: config-service単体テスト成功。破損したprojects設定の検出を再現。
- **残作業**: pty-service / hook-service / file-service / IPC adapterの抽出。破損layoutは現在defaultへ戻すため、「破損設定では起動を止める」という決定を完全には満たしていない。

### R5: 統合検証（未実施）
- `npm test`: 88件成功（既存51 + R0 27 + R4 10）。
- `npm run build:renderer`: 成功。
- **未実施**: `node test/phase4-ui-check.cjs`、installed/dev同時起動、MCP get_focus/show_file、project A/B切替の実Electron検証。これらはユーザー環境での手動実行が必要。

## AI Cortexへの反映

現時点では `AI Cortex > projects` にProject Mixerページがない。計画確定後、ユーザー確認を得て`Project Mixer > context`を作成し、現在地と未解決事項を記録する。実装で確定した仕様だけを`spec`へ反映し、設計判断を`decisions/`へ記録する場合は別途確認する。

### 記録提案（ユーザー確認待ち）
- `decisions/`: Zod導入の決定、未帰属hook通知をpersistent noticeとした決定、破損設定で起動を止める決定、機能追加再開をR2完了まで保留した決定。
- `notes/`: Zod 4.4.3のpassthrough schemaがextra keysを許容する挙動（phase3のtraceテスト互換用）。
- `context`: R0完了、R1概ね完了、R2–R4部分実装。R2の注意状態移行、R3のcontroller抽出、R4の残りservice抽出、破損layoutの扱い、R5実Electron検証が残作業。
