# TUIを維持した指示・結果受け渡しの検証プラン

作成日: 2026-10-10
状態: 方針整理・検証準備。実装・実機検証は未実施。
採番: TH-0〜TH-5。既存のPhase / AL番号とは別体系。

## 1. 方針

Project Mixerはエージェントツールを連携・コントロールするレイヤーであり、各ツールの対話UIを再実装するエージェントクライアントにはしない。

- 各agentはPTYで起動し、本来のTUIを表示・操作する。
- exec、ACP、app-serverによる独自UIへの置き換えを本計画の基盤にはしない。
- MCP Tasks / サーバーpush対応は見送り。通常のMCP呼び出しは必要に応じて利用できる。
- 自動注入は不採用と決めず、指示の受理を別経路で確認する方式を検証する。
- 受け渡し契約は共通化し、ファイル、MCP、ローカルHTTP、共通CLIなどの輸送経路と分離する。
- 基本利用に専用integrationを必須としない。任意の薄いadapterや既存hookを排除する「個別コード追加ゼロ」は要件にしない。
- 通知の取得経路は用途ごとに選ぶ。無出力タイマー、CPU、quiescenceによる汎用waiting推定を本計画の必須機能にしない。
- 子の常時監視や自動再試行を先に作らない。まず具体的な1往復の成立を確認する。

## 2. 根拠と未確認事項

Context Mixer「18_統合実装作業状況」の10月9日追記では、PTY書き込みと入力欄への文字挿入は確認済み。一方、trustゲート、MCP起動待ち、staleな検証インスタンスなどが混在し、正常な既存セッションに対する送信受理は切り分けられていない。

したがって「自動注入は不可能」とは扱わない。実測対象を次の段階へ分解する。

| 段階 | 証拠 | 意味 |
|---|---|---|
| 指示を用意 | PMのrequest記録 | まだ送信していない |
| PTYへ書き込み | IPC成功・送信時刻 | TUIやモデルの受理は未確認 |
| agentが受理通知 | requestIdに対応したack | 契約を読み、返答経路を利用できた |
| 結果を受領 | result通知・ファイル | agentの自己申告結果 |
| 成果を確認 | 実際の成果物・必要な検証 | 依頼に応じた成功確認 |

通知が来ない場合は「受理未確認」。未実行とは断定しない。ackやcompletedも指示の完全な遵守・成果の正しさを保証しない。

## 3. 最初の検証用途

最初は人間が正常動作を確認した既存TUIタブ1つに、無害な短い依頼を送る。

例: 依頼ファイルからnonceを読み、ackを返し、そのnonceを含む結果を専用出力先へ返す。リポジトリ編集、外部送信、承認の自動操作は行わない。

TH-1では人間からagentへの送信のみを検証する。TH-4で別のTUIから親へ結果を返す経路を検証する。新規子の自動起動、複雑な委譲、長時間作業はその後。

## 4. 共通受け渡し契約（検証案）

最初のPoCは通常ファイルI/Oで検証する。これは本採用の輸送経路をファイルに固定する決定ではない。

### 識別

- 各依頼に推測困難なrequestIdとnonceを発行する。
- profile / project / 対象tab・PTYの識別子をPM側の記録へ保持する。
- 再送・再検証はattemptIdで区別する。タイムアウト後も元の依頼を保持する。
- active tabやcwdの一致で返答先を推測しない。終了済みPTY、別profile、別依頼の返答は混ぜない。

### ファイル例

```text
<検証専用run directory>/<requestId>/
  request.json
  instruction.md
  ack.json
  result.json
```

PMがrequestとinstructionを作成し、agentがackとresultを書く。PMの状態記録はagentの出力と分離する。ディレクトリはprofileで分離し、通常のプロジェクトファイルとしてcommitしない。

最小field:

| ファイル | field |
|---|---|
| request.json | schemaVersion、requestId、attemptId、nonce、createdAt、出力先 |
| ack.json | schemaVersion、requestId、attemptId、nonce |
| result.json | schemaVersion、requestId、attemptId、nonce、outcome、summary、artifactPaths |

outcomeはcompleted / failed / needs_input。needs_inputは終了成功とせず、人間へ質問を表示する。進捗heartbeatは初期範囲に含めない。

### 送信内容

短い指示でinstructionの絶対パスを示す。instructionには「ackを先に返す」「指定出力先のみ使う」「結果を返す」を書く。モデルに対する指示であるため、遵守は観測して評価する。

書き込み完了は同じディレクトリの一時ファイルからrenameして公開する方式を試す。Windowsでのrename・重複・上書き挙動も検証する。部分JSONは完了通知とせず、サイズ上限・schema・ID・nonce・artifactの許可範囲を検証する。ファイル通知は真正性の完全な証明ではなく、同一OSユーザー配下の協調契約である。

watchは検知の補助。定期再走査でイベント取りこぼしを補う。既存ファイル、遅延通知、重複通知を同じ状態へ収束させる。

### 状態とタイムアウト

prepared → sent_unconfirmed → acknowledged → result_received → verified

- ack期限超過はack_timeoutへ。時間は設定可能とし、検証値を記録して調整する。
- 遅れてack/resultが来た場合はlateとして記録する。結果が先に来た場合も破棄せず、ack欠落を記録する。
- タイムアウトで自動再送しない。最初は人間がTUIを確認し、再送するか判断する。
- 中断要求と実際の停止は区別する。ファイル削除や依頼取り消しでagentが止まったとは扱わない。
- 同一tabへ複数の自動指示を並行送信しない。人間の入力と競合し得る場面では送信を保留し、勝手に入力行を消さない。

## 5. 実施順序

### TH-0: 実行環境と証拠の基準線

- [ ] 実際のPTY起動経路を確認し、実行ファイルの絶対パス、引数、版、profileを記録する。
- [ ] 明示パスを設定できる最小変更の必要性を判断する。where.exeはWindowsの候補探索補助で、全OS共通方式とはしない。
- [ ] 各toolのversion取得方法は検証済みのもののみ使い、ログへ秘密情報を出さない。
- [ ] source/bundleと起動中rendererが一致すること、接続先PID・起動時刻を確認する。
- [ ] 常用profileと無関係なprocessには触れない。dev設定を変更する場合はbackupと復元手順を先に用意する。

終了条件: どの実行ファイル・版・PMインスタンスで検証したか再現できる。

### TH-1: 正常な既存TUIへの注入を切り分ける

- [ ] 人間の手入力で正常応答を確認する。
- [ ] 同じタブへ、同等の短い指示を既存Composer送信経路から送る。
- [ ] 文字挿入と送信を分け、bracketed paste modeと改行の扱いを記録する。
- [ ] ファイルackと結果を受領する。TUI表示だけを成功条件にしない。
- [ ] 条件を揃えて3回繰り返す。結果は成功数/試行数、ack遅延、失敗した段階で記録する。

終了条件: 正常既存セッションの文字挿入→送信→受理→結果が成立、または差が生じる段階を特定できる。

### TH-2: 契約の異常系

- [ ] 無通知、ackのみ、result先着、期限後のack/result。
- [ ] 部分JSON、不正schema、別requestId/nonce、重複・古いattemptの返答。
- [ ] 同一projectの2タブ、別project、別profileで誤帰属しない。
- [ ] watcher通知欠落、PM再起動、対象tab終了後の返答。
- [ ] ack後のfailed / needs_inputと、成果物不一致を成功扱いしない。

終了条件: 誤成功・誤配達・自動重複実行を防ぎ、未確認を未確認として表示できる。

### TH-3: Fresh sessionと対応toolの拡大

- [ ] TH-1をCodex / Claude Code / OpenCode / Devinの実際に導入された版で実施する。
- [ ] 一度に1tool・1条件を追加し、既存セッションの結果とfresh sessionの結果を分ける。
- [ ] freshでlogin/trust/承認が出た場合は人間が解消し、その後の同一セッションで比較する。自動でtrustを承認しない。
- [ ] 「起動中に先に送る」と「正常応答確認後に送る」の違いを調べる。固定待ち時間だけでreadyと断定しない。
- [ ] ファイルread/write許可がない場合の代替として、通常MCP等の経路を比較する。

終了条件: tool別・版別・ready条件別の対応表ができる。失敗だけを理由にexecへ置き換えない。

### TH-4: 親への返答を1往復で検証

- [ ] 正常な親TUIと返答元TUIを用意し、replyToの対象を固定する。
- [ ] 返答元がresultを公開し、PMが短い結果ファイル参照を親へ送る。
- [ ] 親がその通知用requestIdをackし、結果nonceを使った追加出力を作る。
- [ ] 親が作業中、入力編集中、承認画面にいる場合の保留・未確認を記録する。
- [ ] 親の受理と実際の続行まで確認する。PMが結果を取得しただけで返答経路完成としない。

終了条件: 返答元→PM→親の受理→親の続行が、本来のTUIを維持して実証できる。

### TH-5: 最小実装と統合

TH-1〜TH-4の結果を見て、受け渡し経路、ready条件、タイムアウト、送信競合時の方針を決める。

- [ ] 確認できた契約だけを共通モジュールへ実装する。
- [ ] 表示は送信・受理未確認・受理済み・結果受領・要入力・失敗を区別する。既存Attentionのacknowledgementと依頼ackを混同しない。
- [ ] 既存通知経路を再利用し、同一イベントの重複を整理する。
- [ ] 意味のある境界・状態遷移テスト、npm test、build:renderer、実Electronでの送信確認を行う。
- [ ] packaging対象、profile分離、設定復元を確認する。

終了条件: 通常TUIの操作を維持し、確認済み条件で受け渡しできる。未対応条件を明示する。

## 6. 既存コードとの接点

- main.js: PTY起動、pty:write、command:check。実行ファイルの明示と送信先identityを確認する。
- renderer.js: Composerのbracketed paste送信。新しい独自送信方式を作る前に既存経路を比較する。
- preload.js: ptyWriteの橋渡し。IPC成功とagent受理を分ける。
- src/main/integration-probe.cjs: prompt契約と実際の通知を区別する。managed指定だけで今回のack成功としない。
- src/attention/: 既存通知・Inboxへ必要な結果だけを接続する。

実装時は改めて最新のコードを確認する。今回の変更はこの計画書のみで、既存の未追跡ファイル・ローカル状態は変更しない。

## 7. 記録と判定

各試行でrequestId、対象tool・絶対パス・版、profile、手入力対照、送信時刻、ack/result受信時刻、検証成果物、失敗段階、復元結果を記録する。鍵・tokenや通常会話本文は記録しない。

少数の成功は一般的な信頼性の証明としない。正常既存TUI、fresh session、busy時、承認時を別条件として評価する。

Context Mixerの10月9日追記は過去の実測記録として保持する。本計画はその「TUI注入不採用・子はexec」という帰結を再検証するものであり、過去記録を上書きしない。

共有ナレッジのcontext / 設計文書への反映は、内容を確認後にまとめて行う。今回はローカル計画書の作成のみ。
