# B1 着手ハンドオフ（次セッション用）

**作成日**: 2026-08-25
**目的**: マルチペイン Phase 8 / B1（ペイン配列化）を次セッションで着手するための引き継ぎ

---

## 0. 読むべき文書（この順で）

1. `docs/MULTI_PANE_PROPOSAL.md` — **Phase 8 の確定仕様**（Context Mixer `17_マルチペインと注意の観測` と同一内容。ユーザー承認済み・状態「確定」）
2. `docs/EDITOR_AND_SPLIT_PLAN.md` Phase B 冒頭の改訂注記（旧 2分割固定仕様は経緯扱い）
3. 本書

## 1. 現在地（2026-08-25 時点）

- ブランチ: `v2`。直近のコミット:
  - `b75d97b` docs: マルチペイン提案を Phase B 仕様として採用
  - `de17732` feat: Alt+click マルチカーソル / 矩形選択
  - `6001689` feat: エディタ磨き（Ctrl+D / 検索ハイライト）+ **scratch の CM6 移行**
- Phase 5（検索・キーバインド）/ Phase 4.5 Phase A（CM6）/ セッションリジューム / OpenCode 通知: **すべて完了・コミット済み**
- `npm test` 全スイート成功。ワーキングツリーに未追跡ファイル多数（Devin probe 系・`.project-mixer/` 等）だが**意図的にコミットしない**

## 2. B1 着手前に把握した調査結果（重要・計画を簡素化する）

1. **`layout.json` はエディタ/ペイン状態を永続化していない**（`saveLayout`/`loadLayout` はターミナルタブ + activeProjectId + terminalSendModes + pushFocusEnabled のみ）。→「旧レイアウト移行」作業は実質不要。ペイン構造は**新規状態としてクリーン導入できる**
2. **`makeHSplitter` が既に実装済み**（renderer.js の makeVSplitter の下）。B2 の水平スプリッターは流用のみ
3. 現行タブモデル: 全ターミナルの `termEl` が `#terminal-container` に同居し、`switchTab(tabId)` が「全て非表示 → 1つ表示」。**マルチペイン化の本体はこのモデルを「ペインごとのタブバー + 各ペインのアクティブタブ同時表示」へ変えること**
4. `projectEditorStates`（プロジェクト切替時の退避・復元）がペイン状態の保存先として自然

## 3. B1 実装計画（この順で）

| ステップ | 内容 | 備考 |
| --- | --- | --- |
| 1 | `panes` 状態導入: `[{ id, tabIds: [], activeTabId, ... }]` を `projectEditorStates` に格納。プロジェクト切替で退避・復元 | 1ペイン = 現行形と等価になることを最初に保証 |
| 2 | `#terminal-container` をペインの flex コンテナへ。`termEl` をペイン div へ移動（DOM 移動後 `fit()` 再呼び — xterm は DOM 移動に耐えるが寸法再計測が必須） | `resizeTerminalToContainer` / `handleResize` を全可視ペイン対応に |
| 3 | コマンド `pane_split` / `pane_close` / `focus_pane` を **types.js + schemas.js の両方**に定義（D19 — 片方だけだと起動が壊れる過去事故あり）。ペインごとのタブバー | MCP 非公開（D11） |
| 4 | エディタ/プレビュー/検索タブのペイン配置（§4.2）。webview はタブ移動で再読込（仕様として明記、スクロール復元は `capturePreviewScroll`/`restorePreviewScroll` 済み） | 非表示タブの webview は `about:blank` 破棄（既存実装踏襲） |
| 5 | push 拡張（提案 §4.7・0.5日）: 送信時に可視ペイン構成を本文へ追加。**D24 の最小検証を兼ねる** | |

**含めないもの**: 入れ子（フラット横N/縦Nのみ・決定済み）、ドラッグ&ドロップ（右クリック移動のみ）、get_focus v2（D13 再々改訂の未決のため別扱い — 提案 §5）

## 4. 検証（B5 チェックリストは提案 §8 参照）

最低限:
- [ ] 1ペイン状態が現行と完全同等（回帰）
- [ ] 横2枚で2ターミナル同時描画、スプリッターで全可視 `fit()`
- [ ] プロジェクト切替でペイン構成が復元される
- [ ] `npm test` / `npm run build:renderer` / kamox 実機確認

## 5. 注意事項

- **ターミナルのキーを削らない**: 新キーバインドは D21 レジストリ経由。`focus_pane` は `Ctrl+1`〜 を提案（語彙追加は Phase 5 と整合）
- **コマンド定義の追加漏れ**が起動を壊す（過去実績あり）。types.js / schemas.js 両方
- 検証は kamox で実施可能（`kamox electron` → port 3000、`/playwright/evaluate` で `window.__pmDispatch` を駆動）。**kamox 起動には `npm run build` スクリプトが必要**（追加済み）
- dev プロファイル（`--dev`）の userData は `%APPDATA%\Project Mixer Dev`、kamox 経由は `%APPDATA%\Electron` — 設定・セッションの居場所が違う点に注意
- Context Mixer（ナレッジベース）は MCP 登録済み（Claude Code / OpenCode とも）。読み書きが必要な場合は `tools/cm-search.mjs` のパターン（OAuth トークンは `~/.local/share/opencode/mcp-auth.json`）で REST/MCP 直叩りが可能

## 6. 完了条件

提案 §8 の B5 検証項目すべて + push 拡張の動作確認。完了後、`EDITOR_AND_SPLIT_PLAN.md` の Phase B 作業記録を更新し、Context Mixer 側の進捗も記録する。
