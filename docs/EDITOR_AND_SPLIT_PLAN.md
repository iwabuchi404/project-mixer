# Phase 4.5: CodeMirror 6 導入 / Phase 8: メインエリア分割（L2）

**作成日**: 2026-08-17
**改訂日**: 2026-08-17（Phase 5 の重複採番を訂正し、Phase 4.5 / Phase 8 に付け替え）
**位置づけ**: Phase 4（統合ワークベンチ UI）完了後
**出典**: Context Mixer `11_決定と根拠 v2`（D7 / D9 / D10 / D12 / D13-3 / D13-8 / D19）、`16_番号とフェーズの整理`、`docs/PHASE_4_PLAN.md`

---

## フェーズ番号

本書は**2つのフェーズ**を扱う。採番は Context Mixer `16_番号とフェーズの整理`（正本）で 2026-08-17 に確定した。

| 本書での呼称 | Phase 番号 | 内容 |
| --- | --- | --- |
| **Phase A** | **4.5** | CodeMirror 6 導入（D9） |
| **Phase B** | **8** | メインエリアの分割（L2） |

正本の全体像:

| Phase | 内容 | 文書 |
| --- | --- | --- |
| 4 | 統合ワークベンチ UI（L1 案B）✅ | `docs/PHASE_4_PLAN.md` |
| **4.5** | **CodeMirror 6 導入** | **本書 Phase A** |
| 5 | 検索とキーバインド（D21 / D22） | `docs/PHASE_5_PLAN.md` |
| 6 | 動作表示（D15 / kamox 連携） | 別セッションの計画書 |
| 7 | Git 変更状態の簡易表示（D16） | 未作成 |
| **8** | **メインエリアの分割（L2）** | **本書 Phase B** |

### 採番の根拠

- **CM6 が 4.5**: Phase 5 の S3（共通検索バー）がエディタ検索の委譲先として CodeMirror を前提にする（D22）ため、**5 より前に置く必要がある**。既存の 0.5 / 2.5 と同じ「挟み込み」の慣例に従い、6 / 7 を再採番せずに済ませた
- **L2 が 8**: 6 / 7 との順序制約が無いため末尾に追加。再採番は行わない（D 番号と同じく「振り直すと過去ログとの対応が切れる」ため）
- **文書を分けない理由**: 順序の根拠（A → B）と、両者が共有する状態モデルの議論（A2 が B1 の前提）が分割できないため

> **初版は「Phase 5」を名乗っていた。** 正本で Phase 5 が「検索とキーバインド」に確定済みだったため衝突しており、再発防止ルール2 の違反だった。番号を取り下げたうえで上記に付け替えている。

### 番号順 ≠ 実行順

| 依存 | 内容 |
| --- | --- |
| Phase 5 の S3 → **Phase 4.5** | 共通検索バーのエディタ側委譲先が CodeMirror の検索 |
| **Phase 8** → **Phase 4.5** | 分割は「1ドキュメント : N ビュー」を要求する。A2 が構造上の前提 |
| Phase 5 の S0〜S2 | Phase 4.5 に依存しない。**並行可能** |

---

## 位置づけ

Phase 3 で**操作の文法**（コマンド層）、Phase 4 で**配置の文法**（案B / メインタブ）が入った。本書の2フェーズは**ファイル面そのもの**を作り直す。

対象は2つ。

| | 内容 | 根拠 |
| --- | --- | --- |
| **A** | ファイルエディタを CodeMirror 6 にする | D9（条件成立・採用済み） |
| **B** | メインエリアの分割（L2） | `15_Phase2.5` で「いずれ必要になる見込み」として保留されていた項目 |

---

## 順序の結論: A → B

**コード機能（CodeMirror 6）を先、分割（L2）を後にする。**

### 根拠1: 状態モデルの依存が一方向

現在のファイルエディタは `#file-editor-textarea` 1枚の `value` をタブ切替のたびに差し替える方式（`renderer.js:2299`）。分割が要求するのは「1ドキュメント : N ビュー」の分離だが、CodeMirror 6 は `EditorState`（ドキュメント）と `EditorView`（表示）が最初から分離している。

**A を先にやれば、B が要求する構造がそのまま手に入る。** 逆順にすると textarea 用の多重化を一度作って捨てることになる。

### 根拠2: D9 の着手条件は既に成立済み

D9 の着手条件は「行単位の指差しチャネル（`show_file` または行選択送信）を実装すると決めたとき」だったが、Phase 3 で `show_file(path, line)` と `preview_reveal` が実装済み（`src/mcp/server.cjs:52`、`renderer.js:4189`）。待ち条件は残っていない。

### 根拠3: ファイル面が現在二重になっている

行ハイライトは preview 側（webview へ HTML を生成する経路・`renderer.js:2114-2120`）にしかなく、編集側の textarea には存在しない。読む面と書く面が別物になっている。CM6 はこれを1面に畳めるが、**B を先にやるとこの二重の面を2つの箱に増やすことになる。**

### 順序を動かさない材料

`11_決定と根拠 v2` の D13 再改訂に「`get_focus` は L2 実装後に再検討」とあるが、`get_focus` は既に実装済み（`renderer.js:4217`）。順序の根拠にはならない。

---

## スコープ確定: D7 / D9 の歯止めを厳守する

**決定（2026-08-17）**: シンタックスハイライト・補完・LSP は入れない。`decisions` の改訂は行わない。

D9 の歯止めは有効なまま:

> `package.json` に `@codemirror/lang-*`、`@codemirror/autocomplete`、LSP 系が現れたら違反。

### 依存パッケージは3つだけ

```
@codemirror/state      ドキュメント（EditorState）
@codemirror/view       表示・行番号・ガター・デコレーション
@codemirror/commands   基本キーバインドと undo 履歴
```

### `basicSetup` を使わない（重要）

CM6 の「簡単に済ませる」既定ルートである `codemirror` メタパッケージの `basicSetup` は、中身に `autocompletion()` と `lintKeymap` を**含む**。歯止めと両立しないため使用しない。拡張を明示列挙する。

```js
import { EditorState } from '@codemirror/state'
import {
  EditorView, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, dropCursor, keymap,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'

const extensions = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  drawSelection(),
  dropCursor(),
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
]
```

### 入れるもの / 入れないもの

| 入れる | 入れない |
| --- | --- |
| 行番号・ガター | シンタックスハイライト |
| 行への scroll + 持続ハイライト（A3） | 補完 |
| タブごとの undo 履歴・カーソル・スクロール（A2） | LSP・診断表示 |
| 行選択 → scratch 送信（A4） | フォーマッタ |

### `@codemirror/search`（判断済み・2026-08-17）

`@codemirror/search` は歯止めのリスト（`@codemirror/lang-*` / `@codemirror/autocomplete` / LSP 系）に含まれず、D22 が「エディタ検索の委譲先 = CodeMirror の検索」と明示している。**採用する。**

ただし追加は本書ではなく **`docs/PHASE_5_PLAN.md` の S3（共通検索バー）で行う**。本書 Phase A の依存は3パッケージのまま変えない。

---

## Phase A（= Phase 4.5）: CodeMirror 6 導入

### A1. 単一ビューへの置き換え（0.5日）

- [ ] `@codemirror/state` / `@codemirror/view` / `@codemirror/commands` を追加する
- [ ] `#file-editor-textarea` を CM6 `EditorView` 1個に置き換える（`index.html` / `renderer.js:123`）
- [ ] 拡張は上記の明示列挙のみ。`basicSetup` は使わない
- [ ] `update_editor_content` / `update_editor_selection` の発火元を CM6 の `updateListener` へ差し替える（`renderer.js:2495`、`renderer.js:2524`）
- [ ] **コマンド語彙は変更しない**（D10 維持）。変えるのは発火元だけ

**注意**: esbuild は Phase 0.3 で導入済みなので、ESM のみの CM6 でも経路は通っている。バンドルサイズの増分を計測して記録すること。

### A2. ドキュメント状態の per-file 化（1日）★Phase B の前提

- [ ] `openFiles` の各エントリに `EditorState` を持たせる（現在は `content` 文字列のみ・`renderer.js:1246`）
- [ ] タブ切替を `view.setState(f.state)` にする（現在は `fileEditorTextarea.value = f.content`・`renderer.js:2299`）
- [ ] `saveCurrentEditorState` / `switchProjectEditor` のプロジェクト別退避が `EditorState` を保持することを確認する（`renderer.js:1270` / `renderer.js:1287`）
- [ ] dirty 判定（`originalContent` との比較）を `state.doc` ベースに移す

**副産物**: タブごとに undo 履歴・カーソル・スクロールが保持される。現在は切替で失われている。

**ここが Phase B との接合点。** A2 まで終われば、B は「View を増やす」だけになる。

### A3. 行の指差しをエディタ側へ移す（1日）

- [ ] `preview_reveal` の対象を、テキスト/コードファイルについてエディタにする（`renderer.js:4189`）
- [ ] `EditorView.scrollIntoView` でスクロールし、`StateField` + `Decoration.line` で範囲をハイライトする
- [ ] Markdown / HTML / 画像 / ブラウザは従来どおり preview のまま（`renderer.js:2122-2144` の分岐は維持）
- [ ] テキストファイル向けの `buildLinePreviewDocument` 経路（`renderer.js:2114-2120`）が不要になるので削除する
- [ ] **D13-3 の未決を確定する**: ハイライトをいつ消すか（次の操作で消す / 数秒でフェード / 明示的に閉じるまで）

**本フェーズで唯一の自前実装箇所。** `scrollIntoView` はライブラリだが、持続ハイライトは `StateField` + `Decoration.line`（CM6 の定番パターン、20行程度）。ここが `show_file` の指差しの本体であり、削ると CM6 を導入する理由が消える。

### A4. 行選択 → scratch 送信（0.5日）

- [ ] 選択範囲を `path:L10-L20` 形式のラベル付きで scratch へ挿入する
- [ ] 既存の push_focus（context チェックボックス）経路に載せる。新しい送信経路を作らない
- [ ] コマンドを1つ追加する場合は `src/commands/types.js` と `src/commands/schemas.js` の**両方**に定義する（後述の注意参照）

D9 の着手根拠「行を指差す行為＝空間的指示の翻訳」を実際に回収する部分。

### A5. 検証（0.5日）

- [ ] `npm test` が通ること
- [ ] `npm run build:renderer` が通ること
- [ ] 実 Electron 起動で回帰確認（AGENTS.md の手順）
- [ ] 追加テスト: タブ切替で undo 履歴・カーソルが保持されること
- [ ] 追加テスト: `preview_reveal` が指定行を表示すること
- [ ] **追加テスト（歯止めの機械化）**: `package.json` に `@codemirror/lang-*` / `@codemirror/autocomplete` / LSP 系が存在しないことを検査する。D9 の歯止めを実装で固定する

---

## Phase B（= Phase 8）: メインエリア分割（L2）

### B0. 仕様確定（0.5日）— 飛ばすと必ず作り直しになる

Phase 4 で **「ターミナルとプレビューは時間的に排他だから分割しない」** と決着している（`docs/PHASE_4_PLAN.md:95`）。**この判断は覆さない。** 分割が必要なのは別の組み合わせであることを書き分ける。

| 組み合わせ | 分割 | 理由 |
| --- | --- | --- |
| ターミナル ↔ ターミナル | **する** | 複数エージェントの同時監視。PM の中核価値そのもの |
| ターミナル ↔ エディタ | **する** | 行を指しながら指示する。Phase A で作ったチャネルの受け皿 |
| ターミナル ↔ プレビュー | **しない** | D12 の判断を維持（時間的に排他） |

- [ ] 分割の単位は**中央エリアのみ**とする（scratch は含めない）
- [ ] **2分割固定**とする（縦または横に1回）。任意ツリーはレイアウト永続化と webview 管理のコストが跳ねる
- [ ] `<webview>` は**1個のまま維持する**（D14 / WebGL コンテキスト上限）。「プレビューは片側でしか開けない」を仕様として明記する
- [ ] 上記を `11_決定と根拠 v2` の D12 に追記するか、ユーザー確認のうえ決定する

### レイアウトライブラリは導入しない

Golden Layout / Dockview / FlexLayout はいずれも**タブの状態を自分で持つ**ため、以下と衝突する。

| 衝突先 | 内容 |
| --- | --- |
| D10（全操作をコマンド層経由） | ライブラリ内部の drag / close がコマンドを通らない |
| Phase 4 で1本化した Tab コンポーネント | 見た目とイベントが二重管理になる |
| `projectEditorStates` のプロジェクト別永続化 | ライブラリの serialize 形式と二重持ちになる |

一方、必要な部品は既にリポジトリにある。`makeVSplitter(splitterEl, leftEl, rightEl, minLeft, minRight, onResizeEnd)`（`renderer.js:3707`）は汎用ファクトリで、B2 は実質これを1回追加で呼ぶだけになる。

### B1. タブグループのデータ構造化（2日）★本フェーズの実コスト

- [ ] `projectEditorStates` の各エントリを「1グループ」から「グループの配列（最大2）」へ変更する（`renderer.js:1259`）
- [ ] `activeMainFilePath` / `activeSurface` / `previewReturnFilePath` をグループ単位へ移す（`renderer.js:1270-1330`）
- [ ] `layout.json` のスキーマを更新し、**旧形式からの移行**を実装する（1グループ = 既定の左ペイン）
- [ ] `validateLayout`（`src/main/config-service.cjs`）を新スキーマに合わせる。D18 のとおり layout.json の破損は非致命的（リセットして継続）

**ここが一番壊れやすい。** レイアウトライブラリを入れてもこの作業は消えず、むしろ自前の永続化との突き合わせが増える。

### B2. DOM とスプリッター（0.5日）

- [ ] `#main-surface` を2グループ構成にする（`index.html`）
- [ ] `makeVSplitter` を再利用してグループ間スプリッターを追加する（`renderer.js:3707`）
- [ ] 各グループに独立したタブバーを持たせる。Tab コンポーネントは Phase 4 で1本化済みなので再利用する
- [ ] **ターミナルは `display:none` にせず非ゼロ寸法を維持し、リサイズ時に全可視ターミナルへ `fit()` を呼ぶ**（Phase 4 の実装結果に記録済みの注意）

### B3. コマンド追加（0.5日）

- [ ] `pane_split` / `pane_close` / `tab_move_to_pane` を追加する
- [ ] **`src/commands/types.js` と `src/commands/schemas.js` の両方に定義する**（D19: Zod 検証）

> **注意**: Phase 2.5 のレビューで「コマンド定義の追加漏れが起動を壊す」が**最大の問題**として記録されている。片方だけの追加は起動時に落ちる。

- [ ] MCP へは公開しない。分割はエージェント都合の操作であり、D11 の「Shared View に載るか」で落ちる

### B4. 検証（1日）

- [ ] 2ペインで両方のターミナルが同時に描画されること
- [ ] スプリッターのドラッグで両方のターミナルが `fit()` されること
- [ ] プロジェクト切替でグループ構成が復元されること
- [ ] **旧 `layout.json` から起動できること**（移行の検証）
- [ ] `<webview>` が1個のまま維持されていること
- [ ] `npm test` / `npm run build:renderer` / 実 Electron 起動確認

---

## Phase C: L2 後の回収（任意・本フェーズ外）

着手は別途判断する。

- `get_focus` の再検討 — D13 再改訂で「L2 実装後に再検討」とされていた項目。ターミナルとファイルが同時に見える状態が初めて生まれるため、`watching_you` と `file` が両立する
- `pending_marks`（D13-8）— CM6 のガターに印を付ける。Phase A の上に乗る。「非同期の印」モデルのため、ブロッキングにしないこと

---

## 見積もり

| 段階 | 内容 | 日数 |
| --- | --- | --- |
| A1 | 単一ビュー置き換え | 0.5 |
| A2 | per-file `EditorState` | 1 |
| A3 | 行の指差しをエディタへ | 1 |
| A4 | 行選択 → scratch | 0.5 |
| A5 | 検証 + 歯止めテスト | 0.5 |
| B0 | 仕様確定 | 0.5 |
| B1 | グループ配列化 | 2 |
| B2 | DOM + スプリッター | 0.5 |
| B3 | コマンド追加 | 0.5 |
| B4 | 検証 | 1 |
| | **合計** | **8** |

日数は目安。B1 の移行実装が読みにくいため、ここだけ振れ幅が大きい。

---

## リスクと注意

| 項目 | 内容 |
| --- | --- |
| **`basicSetup` の誤用** | 楽なので手が伸びるが `autocompletion()` を含む。A5 の歯止めテストで機械的に検出する |
| **コマンド定義の追加漏れ** | `types.js` と `schemas.js` の片方だけ追加すると起動が壊れる。Phase 2.5 で実際に起きている |
| **B1 の移行漏れ** | 旧 `layout.json` で起動できなくなると常用版に戻れない。B4 で必ず検証する |
| **ターミナルの寸法** | 非表示グループを `display:none` にすると xterm.js の寸法計測が 0 になる。Phase 4 と同じ罠 |
| **`<webview>` の増殖** | 分割時に片側ずつ持たせたくなるが、D14 / WebGL コンテキスト上限のため1個を維持する |
| **バンドルサイズ** | CM6 の増分を A1 で計測し記録する。想定を大きく超える場合は拡張列挙を見直す |

---

## 作業記録

### Phase A

- [x] A1 完了 — 2026-08-22。`#file-editor-textarea` を `#file-editor-mount`（CM6 `EditorView` 1個）に置換。拡張は明示列挙（lineNumbers / highlightActiveLineGutter / highlightActiveLine / drawSelection / dropCursor / history / keymap）。`basicSetup` 不使用。Tab → 2スペース挿入は旧 textarea 挙動を維持（cm6.mjs 内の keymap）。`update_editor_content` / `update_editor_selection` の発火元を `updateListener` へ差し替え。コマンド語彙は変更なし（D10 維持）。テーマは styles.css の CSS 変数で上書き（one-dark 等の追加パッケージは不使用）
- [x] A2 完了 — 2026-08-22。`openFiles` エントリが `state`（EditorState）と `scrollTop` を保持。タブ切替は `view.setState(f.state)` + スクロール復元。プロジェクト別退避は既存の `saveCurrentEditorState` / `switchProjectEditor` がエントリごと state を運ぶため追加コード不要（プロジェクト切替時に `syncMountedFileScroll()` を1呼び追加）。dirty 判定は `isDocDirty(state, originalContent)`（`src/editor/doc-state.mjs`、旧 textarea 計算との等価性をテストで固定）。undo 履歴・カーソルは state ごとタブに保持
- [ ] A3 完了 —
- [ ] A4 完了 —
- [ ] A5 完了 —

**A1/A2 実装メモ（2026-08-22）**:

- 追加パッケージ: `@codemirror/state@6.7.1` / `@codemirror/view@6.43.9` / `@codemirror/commands@6.11.0` の3つのみ（歯止めどおり）
- **バンドルサイズ増分**: 1,316,955 → 1,962,667 bytes（+645,712 bytes、非圧縮・sourcemap 込み出力は別ファイル）。minify は現行ビルドでも無効のため既存と同一条件での比較
- 新規モジュール: `src/editor/cm6.mjs`（View 生成・拡張列挙・revealLine）、`src/editor/doc-state.mjs`（純粋ヘルパー、DOM 非依存で単体テスト可能）
- デッドコード削除: `applyEditorSurface` / `getSelectionRange` / `showMainEditorSurface`（いずれも未使用・旧 textarea 参照）
- テスト: `test/codemirror.test.cjs` を新規追加（11件、`npm run test:codemirror`、`npm test` に組込み）。doc-state の意味論（旧 textarea 計算との等価性）、D9 歯止め（依存3パッケージ限定・basicSetup 不使用・lang/autocomplete/lint 不使用）、配線の静的検査。`test/phase4.test.cjs` のセレクタアサーションを `file-editor-mount` に更新
- `npm test`: 159件成功（12スイート）/ `npm run build:renderer`: 成功
- **検証で発見・修正したバグ（2026-08-22、kamox による実機確認）**:
  1. **`EditorView` に `state` を渡すと `extensions` が無視される** — CM6 の仕様。初版は View 生成時に `state` と `extensions` を両方渡しており、行番号・history・updateListener がすべて効いていなかった（表示だけは動くため発見が遅れた）。`createEditorKit` が1つの extensions 配列を View の初期 state と `createState()` の両方に渡す形に修正。**per-file の state も拡張を自身で持たねばならない**（`setState()` で後から載せる state に拡張がないと history が死ぬ）
  2. **`EditorState.create` が CRLF を LF に正規化する** — CRLF ファイルが開いた直後から常に dirty 判定になり、保存すると CRLF→LF に書き換わる潜在バグ。`detectEol` / `applyEol`（`src/editor/doc-state.mjs`）でファイルの EOL を記憶し、保存時に復元する方式で修正。dirty 判定の baseline も正規化後テキストに統一
- **kamox 実機検証結果（A5 の手動確認のうちエディタ周り）**: アプリ起動・エラーログ クリーン / CM6 描画 + 行番号 / 入力 + dirty マーク / タブ切替でファイル内容・編集・undo 履歴・スクロール位置がすべて保持される / CRLF ファイルの開直後 clean・undo 後 clean を確認
- **未実施（A5 で実施）**: 実 Electron 起動での残り回帰確認（terminal link クリックの行ジャンプ、プロジェクト切替の復元、get_focus の cursorLine は別途確認）

### Phase B

- [ ] B0 完了 —
- [ ] B1 完了 —
- [ ] B2 完了 —
- [ ] B3 完了 —
- [ ] B4 完了 —
