# Devin CLI 通知統合 実装結果

**更新日**: 2026-08-13  
**対象**: Project Mixer v2 / Devin CLI 3000.4.16 / Windows  
**状態**: Attention通知経路の実装・実機確認完了

## 結論

Devinの承認・入力待ち通知には`PermissionRequest` Hookを使用せず、公式terminal notificationのOSC 9 / OSC 777を利用する。ACPやCloud API pollingには依存しない。

```text
Devin TUI
  └─ PTY output
       ├─ OSC 9   ─┐
       └─ OSC 777 ─┴─→ Devin adapter → Attention Store → terminal / project badge
```

`UserPromptSubmit`と`Stop` Hookは実機で発火を確認しているが、現時点のAttention通知はOSCだけで成立する。Hook Bridgeによるturn相関は別段階とする。

## 調査結果

Devin TUIで承認画面が表示されても、`PermissionRequest` command Hookは一度も発火しなかった。ProbeはHook開始直後に`called` markerを書くため、stdin処理ではなくDevin側からHookが呼ばれていないことを確認できた。内部原因は未確認であり、Claude CodeやKimiと同一原因とは断定しない。

`notify: "always"`を指定したD0b Probeでは、次の信号を実測した。

| 状態 | 発火順 | 内容 |
|---|---|---|
| 承認待ち / 質問待ち | `BEL → OSC 9 → OSC 777` | `Devin needs input` |
| 正常完了 | `BEL → OSC 9 → OSC 777` | `Devin finished` |

OSC 777は`notify;Devin;<message>`形式。承認待ちと通常の質問待ちは同じ内容なので、Project Mixerは両方を`needs_attention(input)`として扱い、`approval`とは推測しない。

## 実装仕様

- `Devin needs input` → オレンジのwaiting表示
- `Devin finished` → 背景タブでは白の未読完了表示
- OSC 9と777の同一通知は`kind:eventType`単位で250ms以内を重複除去
- 未知のprovider・文言・OSC identifierは無視
- waitingはタブを開いただけでは解除せず、対象PTYへのユーザー入力で解除
- 完了通知は対象タブを確認すると既読化
- raw PTY出力やOSC本文はAttention Storeへ保存しない

主要実装は`src/notifications/devin-terminal.mjs`、renderer接続は`renderer.js`、Probeは`tools/devin-hook-probe/`に配置した。

## 検証結果

- Parser・正規化・重複除去のUnit test: 成功
- `npm test`: 全suite成功
- `npm run build:renderer`: 成功
- 実Electron fixture: `needs input → オレンジ`、`finished → 白`を確認
- 実Devin: 承認待ちでDevin / Claude Codeの両方がオレンジになることを確認

初回確認でDevinが白になったが、再試行では再現しなかったため追加修正は行っていない。

## 再調査手順

生のterminal notificationを再確認する場合:

```powershell
cd D:\work\project-mixer
node .\tools\devin-hook-probe\osc-probe.cjs
```

終了後、最新ログを確認する。

```powershell
node .\tools\devin-hook-probe\view-terminal-signals.cjs <log-path>
```

Probeはユーザーconfigを直接変更せず、一時コピーだけに`notify: "always"`を設定する。ログは`.project-mixer/probes/`へ保存され、Git管理対象にはしない。

## 残課題

- Devin更新後に`PermissionRequest` Hookを再検証する
- `UserPromptSubmit` / `Stop`をproduction Hook Bridgeへ接続する場合は、receiver停止、timeout、同一cwd複数PTY、packaged版runtimeを追加検証する
- OSC文言が将来変更された場合は、versionと実payloadを再Probeしてからadapterを更新する

関連資料: [Devin Hooks D0 Probe結果.md](./Devin%20Hooks%20D0%20Probe結果.md)、[Devin Hooks 通知統合計画.md](./Devin%20Hooks%20通知統合計画.md)
