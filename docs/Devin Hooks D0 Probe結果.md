# Devin Hooks D0 Probe 結果

**作成日**: 2026-08-13

**対象**: Project Mixer v2 / Devin CLI 通知統合

**Devin CLI version**: 3000.4.16 (355c3c9e)

**OS / shell**: Windows / PowerShell

**状態**: 実測完了（PermissionRequest blockerの回避経路を確認）

**実装結果**: [Devin CLI 通知統合 実装結果.md](./Devin%20CLI%20通知統合%20実装結果.md)

---

## 1. 確認できた事項

### Hook読み込み

`/hooks` コマンドで3つのhookが `.devin/hooks.v1.json` から読み込まれていることを確認:

```text
Loaded hooks (3 total)
<hook 1> [permission_request] • .devin\hooks.v1.json
<hook 2> [user_prompt] • .devin\hooks.v1.json
<hook 3> [stop] • .devin\hooks.v1.json
```

Devin TUIの表示名とstdin payloadの `hook_event_name` は異なる:
- TUI: `[permission_request]` / `[user_prompt]` / `[stop]`
- stdin: `PermissionRequest` / `UserPromptSubmit` / `Stop`

### payload field matrix

実測したstdin payloadのfield構成:

| hook_event_name | fields |
|---|---|
| `UserPromptSubmit` | `hook_event_name`(string), `prompt`(string), `session_id`(string), `prompt_id`(string) |
| `Stop` | `hook_event_name`(string), `stop_hook_active`(boolean), `session_id`(string), `prompt_id`(string) |
| `PermissionRequest` | **未観測（blocker参照）** |

公式仕様（docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks）と一致。

### session_id / prompt_id の相関

- `session_id`: セッション中固定。2 turn間で同一値を確認（例: `telling-volleyball`）。
- `prompt_id`: turnごとにrotation。同一turn内の `UserPromptSubmit` と `Stop` が同じ `prompt_id` を共有。
- `prompt_id` は最初のpromptより前のイベントでは省略される（公式仕様どおり、今回は未観測だが仕様通りとみなす）。

実測値の例:
```text
UserPromptSubmit  prompt_id=5431537c-...  session=telling-volleyball
Stop              prompt_id=5431537c-...  session=telling-volleyball  stop_hook_active=false
UserPromptSubmit  prompt_id=76db0bef-...  session=telling-volleyball
Stop              prompt_id=76db0bef-...  session=telling-volleyball  stop_hook_active=false
```

### stop_hook_active（競合なし）

競合Stop hookがない状態では `stop_hook_active=false` が一貫（5 turn分で全件 `false`）。

### PM環境変数継承

**確認済み（D0 Gate必須項目）:**

- `PROJECT_MIXER_PTY_ID`: PMのPTYから起動したDevinで **present, value=11**（数値）
- `PROJECT_MIXER_PORT_FILE`: **present**
- `DEVIN_PROJECT_DIR`: **present**（probe workspace path）

PMのPTYから起動した場合のみ `PROJECT_MIXER_PTY_ID` が注入される。通常ターミナルから起動した場合は `PROJECT_MIXER_PTY_ID` が absent（case 7で確認予定）。

**注意**: `PROJECT_MIXER_PTY_ID` のenv注入は未commitの作業コピー変更。commit済みのHEADには `PROJECT_MIXER_PORT_FILE` のみ。検証時はソースからPMを起動する必要がある。

### event ordering

`UserPromptSubmit → Stop` の順序が時系列通りに観測。同一turn内では `prompt_id` が一致。

### hook実行時間

各hookの実行時間（stdin読み込みからexitまで）:
- `UserPromptSubmit`: 6〜9ms
- `Stop`: 4〜7ms

Devin Hook timeout（2秒）に対して十分余裕がある。

---

## 2. Blocker: PermissionRequest hook が発火しない

### 現象

TUIでapproval確認が表示されても、`PermissionRequest` hookが **一度も発火しない**。

### 再現手順

1. probe workspace（`.devin/hooks.v1.json` に `PermissionRequest` hookを設定）でDevinを起動
2. `/hooks` で `[permission_request]` が読み込まれていることを確認
3. permissionが必要な操作を実行:
   - `probe-test.txt に "hello" と書き込んで。実行前に必ず確認を求めて。`
   - `probe-test.txt を削除して。`
4. DevinがTUIでapproval確認を表示
5. ユーザーが承認
6. 完了後、probe logを確認 → `PermissionRequest` の `called` markerもeventも **0件**

### 切り分け結果

- `called` marker（hook呼び出し瞬間の記録）を追加して切り分けを実施
- `UserPromptSubmit` と `Stop` の `called` markerは正常に記録される
- `PermissionRequest` の `called` markerは **1件も記録されない**
- → probe側のstdin処理バグではなく、**DevinがPermissionRequest hookを呼んでいない**

### 原因について

Devin内部でTUI approvalがHook経路を迂回している可能性はあるが、実装上の原因は未確認。Kimi CLI Issue #2337には同種の制約が報告されている。一方、Claude Code Issue #23370は`type: "agent"`固有の問題であり、command Hook全般が発火しない根拠にはならない。したがって「Claude Code、Kimi、Devinが同じ原因」とは断定しない。

### 計画への影響

計画書 section 1 の `PermissionRequest → needs_attention(approval)` はDevin 3000.4.16では利用できない。代わりに、Devin公式terminal notificationをsemantic signalとして利用する。

### 採用判断

**PermissionRequest Hookはblockerとして記録し、初版のAttention通知はOSCを正規経路にする。**

代替案:
1. OSC 9 / OSC 777の`Devin needs input`を`needs_attention(input)`へ変換
2. OSC 9 / OSC 777の`Devin finished`を`turn_completed`へ変換
3. Devin CLI updateでPermissionRequest hookが修正されたら再検証
4. PTY文字列heuristicはOSCが得られない場合だけのfallbackとする

### D0b: terminal notification実測

一時configで`notify: "always"`を指定し、承認待ち、質問待ち、正常完了を実測した。

| 状態 | 発火順 | payload |
|---|---|---|
| 承認待ち / 質問待ち | `BEL → OSC 9 → OSC 777` | `Devin needs input` |
| 正常完了 | `BEL → OSC 9 → OSC 777` | `Devin finished` |

OSC 777は`notify;Devin;<message>`形式。OSC 9と777は同一意味で連続するため、Project Mixer側で短い時間窓により1通知へdedupeする。承認と通常の質問待ちはpayload上区別できないので、`reason: input`へ正規化し、`approval`とは推測しない。

---

## 3. 未確認項目

以下はprobe未実施または未完了。

### case 4: 競合Stop hookがblockする場合

`stop_hook_active` のblock時変化が未確認。OSCが完了通知の正規経路になったためAttention実装のblockerではないが、Stop Hookをturn相関へ利用する前に確認する。

### case 7: receiver停止時の非阻害

probe hook自体はreceiverへPOSTせず常にexit 0で記録するため、Devinは止まらないことが期待される。本番bridgeでも「receiver不在時はexit 0」を実装するため、この挙動がそのまま本番の保証になる。ただし実測は推奨。

### case 6: 同一cwdで2つのDevin

PM PTY起動と通常起動のenv差は確認済み（PTY_IDあり/なし）。同一cwdでのsession_id分離は未確認だが、session_idがセッションごとに固有であることは確認済みのため、routingの基盤は担保されている。

### 同一turn内の複数PermissionRequest

PermissionRequest hook自体が発火しないため、この項目は確認不可。

### packaged版bridge方式

未確認。D4 Setup UXの前に別途検証が必要。

---

## 4. D0 Gate 判定

### 満たした項目

- ✓ 実Devinで `UserPromptSubmit` と `Stop` を取得
- ✓ 実DevinでOSC 9 / 777の`needs input`と`finished`を取得
- ✓ `session_id` / `prompt_id` の相関条件を確認
- ✓ PM環境変数から `ptyId` を取得
- △ receiver停止とtimeout時にもDevinが継続 → 設計上は非阻害、実測未完了
- △ allowlist payloadだけがreceiverへ届く → Probe実装で制限、production bridge未実測

### 未達項目

- ✗ `PermissionRequest` を取得 → **blocker**（Devin実装上の制約）
- △ 同一cwdの2terminalを正しく区別 → session_id固有性は確認済み、同一cwd実測は未実施
- △ competing Stop Hook時の相関挙動 → case 4未実施（Attention通知のblockerではない）
- △ packaged版でsystem Node.jsに依存しないbridge方式 → 未確認

### 結論

**PermissionRequest Hookは不発火だが、公式terminal notificationでAttention通知を回避できる。**

計画を以下のように縮小して進めることを提案する:

1. **Attention通知**: OSCの`needs input`と`finished`を利用
2. **Lifecycle相関**: `UserPromptSubmit`と`Stop` Hookを利用
3. **PermissionRequest Hook**: blockerとして記録し、Devin CLI updateで再検証
4. **case 4, 7**: Hook Bridge実装前に追加probeを実施

この縮小方針でよければ、case 4と7のprobeを実施した後、D1（UserPromptSubmit + StopのみのLifecycle Mapper）へ進む。

---

## 5. 参考資料

- [Devin CLI Hooks Overview](https://docs.devin.ai/cli/extensibility/hooks/overview)
- [Devin CLI Lifecycle Hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)
- [Devin CLI Permissions](https://docs.devin.ai/cli/reference/permissions)
- [Claude Code Issue #23370: PermissionRequest hook not triggering](https://github.com/anthropics/claude-code/issues/23370)
- [Kimi CLI Issue #2337: Approval prompts should trigger a hook event](https://github.com/MoonshotAI/kimi-cli/issues/2337)
