# Project Mixer v2 実装プラン

**作成日**: 2026-08-09
**現行バージョン**: v0.1.0（リリース済み・タグ付き）
**対象**: v2 アーキテクチャ移行

---

## 前提

- **現行版を常用したまま、別ブランチで進める**（doc 12 移行戦略）
- 新版が現行版の日常作業を代替できた日に切り替える
- 下2層（Electron + PTY/送信）は維持、上を組み直す

---

## Phase 0: 開発環境の分離（0.5日）

### 目的
PM 自身が PM 上で開発されているため、`get_focus` 実装後に「エージェントが読んでいるのはどちらの PM の注意状態か」が問題になる。Shared View 実装前に片付ける。

### やること
- [ ] electron-builder インストール版を常用に固定
- [ ] 開発版は `userData` を分けた別プロファイルで起動（`--user-data-dir` フラグまたは環境変数）
- [ ] `v2` ブランチ作成
- [ ] 起動スクリプト（`npm run dev:v2` 等）でプロファイル分離を自動化

---

## Phase 1: コマンド層の骨格 + `get_focus`（3〜5日）

### 位置づけ
- **アーキテクチャの足場**として最優先（doc 13）
- 差別化としては JetBrains/VSCode に削られるが、コマンド層（D10）を実在させるための最初の1機能
- 抽象的な枠から設計すると空回りするため、具体的な要求で骨格を引き出す

### 1.1 コマンド層の定義（D10）

すべての UI 操作に名前を与え、単一のコマンド語彙を通す。

```
MCP (agent) ──┐
キーボード   ──┼→ Command層 → State → 描画
マウス/UI    ──┘
```

**規律**: 状態変更は必ずコマンド経由。ライブラリの選択ではなく規律が本体。

#### 初期コマンド語彙（`get_focus` 実装に必要な分のみ）

| コマンド | 引数 | 由来 | 用途 |
|---|---|---|---|
| `select_project` | `projectId` | マウス/キー/MCP | プロジェクト切替 |
| `open_file` | `path` | ツリーdblclick/MCP | ファイルをエディタで開く |
| `open_preview` | `path` | ツリーdblclick/MCP | ファイルをプレビューで開く |
| `close_tab` | `filePath` | 中クリック/MCP | タブを閉じる |
| `switch_tab` | `filePath` | タブクリック/MCP | タブ切替 |
| `focus_terminal` | `tabId` | タブクリック/MCP | ターミナルにフォーカス |
| `send_to_terminal` | `text, tabId?` | scratch送信/MCP | ターミナルへテキスト送信 |
| `get_focus` | なし | MCP専用 | 人間の注意状態を返す |

**設計原則**: 新機能は必ずコマンド定義を伴う。これにより「つぎはぎ」が構造的に起きない。

#### ファイル構成案

```
src/
  commands/
    registry.js     # コマンド登録・ディスパッチ
    types.js         # コマンド定義（名前・引数・戻り値）
    handlers/
      project.js     # select_project 等
      editor.js      # open_file, close_tab 等
      terminal.js    # focus_terminal, send_to_terminal 等
      focus.js       # get_focus
  store/
    index.js         # 状態ストア（コマンド経由で更新）
  mcp/
    server.js        # MCP サーバ（main プロセス）
    tools.js         # MCP ツール定義（コマンド層のクライアント）
```

### 1.2 状態管理の移行

現状はグローバル変数と DOM。コマンド層に対応する形へ。

- [ ] `store/index.js` に状態を集約
  - `projects`, `activeProjectId`
  - `openFiles`（Map）, `activeFilePath`
  - `tabs`（Map）, `activeTabId`
  - `editorContent`（scratch含む）
- [ ] すべての状態変更をコマンド経由にリダイレクト
  - 既存の `selectProject()`, `openFileInEditor()` 等をコマンドハンドラに変換
  - UI イベントハンドラは `commandRegistry.dispatch('select_project', {id})` を呼ぶだけ
- [ ] 描画は store の変更を購読して更新

**注意**: Vue 3 移行（doc 12）はこの Phase では行わない。まず現行の生 DOM 描画のままコマンド層を挟む。フレームワーク移行は Phase 4 で検討。

### 1.3 `get_focus` MCP ツール実装（D13）

**人間が今見ているもの**をエージェントが問い合わせられるようにする。

#### 返す内容（暫定）

```json
{
  "project": {
    "id": "...",
    "name": "project-mixer",
    "path": "D:/work/project-mixer"
  },
  "editor": {
    "activeTab": "src/main.js",
    "filePath": "D:/work/project-mixer/src/main.js",
    "isPreview": false,
    "selection": { "startLine": 12, "endLine": 18 },
    "cursorLine": 15
  },
  "terminal": {
    "activeTabId": "...",
    "command": "claude",
    "cwd": "D:/work/project-mixer"
  },
  "scratch": {
    "content": "src/main.js の15行目の...",
    "length": 120
  }
}
```

**設計上の注意**:
- 単なる「現在のファイル」ではなく、**人間の注意状態**として設計する
- PM は 5〜10 プロジェクトを抱えるため「どのプロジェクトの」が付く（Copilot より情報量が上回る）
- 巨大な terminal log を自動注入しない（block ID だけ返し、別操作で明示取得）

#### MCP サーバ実装

- [ ] `@modelcontextprotocol/sdk` を main プロセスに追加
- [ ] MCP サーバ起動（stdio または HTTP）
- [ ] `get_focus` ツール定義 → コマンド層経由で renderer から状態を収集
  - main → renderer へ `ipcMain.handle('get_focus')` で状態取得
  - renderer は store から現在の注意状態を構築して返す

### 1.4 検証

- [ ] Claude Code から `get_focus` を呼んで、PM の注意状態が返ることを確認
- [ ] マウス操作・キーボード操作・MCP 操作が同じコマンド層を通ることを確認
- [ ] 既存機能の回帰テスト（ターミナル、プレビュー、ファイルツリー）

---

## Phase 2: スクショ投入の磨き（1〜2日）

### 位置づけ
- **唯一単独で立つ差別化**（doc 13）
- clipaste / Invoke（$49）が存在＝未解決の証拠。Windows では特に弱い
- 現行実装は v1 で完了済みだが、磨きが必要

### やること
- [ ] `Ctrl+V` でクリップボード画像 → プロジェクト配下 `screenshots/` に保存 → パスを scratch に追記
  - 現行実装の動作確認・安定化
- [ ] Devin CLI の画像貼り付け不安定さの調査・改善
  - bracketed paste と画像パス送信の相互作用
- [ ] 保存先ディレクトリのカスタマイズ（プロジェクトごとに設定可能）
- [ ] 画像ファイル名のタイムスタンプ化（重複回避）
- [ ] 複数画像の連続貼り付け対応

### 検証
- [ ] Claude Code / Codex / Devin CLI 全てでスクショ→パス送信→エージェントが画像を認識できることを確認

---

## Phase 3: ツリーフィルタ（0.5日）

### 位置づけ
- **日常価値**（doc 13）。差別化は低いが頻度 7/10
- 道具としての日常価値を上げる

### やること
- [ ] ファイルツリー上部に検索ボックス追加
- [ ] 入力時にツリーを絞り込み（ファイル名部分一致）
- [ ] マッチしたファイルの親フォルダを自動展開
- [ ] `Ctrl+P` で検索ボックスにフォーカス
- [ ] Esc でクリア

### 検証
- [ ] 大きなプロジェクト（100+ファイル）でフィルタが実用的に速いこと

---

## Phase 4: OSC 133 ターミナル意味情報（2〜3日）

### 位置づけ
- doc 14 の調査結果に基づく
- PTY の文字列を、人間が指差せる意味単位（このコマンド・この出力・成功・失敗）へ翻訳
- `get_focus` の拡張候補（Candidate C）

### やること

#### 4.1 OSC 133 パーサ（Candidate A）
- [ ] xterm.js の parser hook で OSC 133 を捕捉
  - `OSC 133;A` = Prompt開始
  - `OSC 133;B` = Prompt終了 / command開始
  - `OSC 133;C` = command実行 / output開始
  - `OSC 133;D;<exitCode>` = command終了
- [ ] 内部モデル `TerminalCommandBlock` を定義
  ```js
  {
    id, terminalId, command?, output, exitCode?,
    startedAt, finishedAt
  }
  ```
- [ ] command 文字列の取得は B〜C間のPTY入力を収集（初期は欠損許容）

#### 4.2 OSC 7 対応（cwd 取得）
- [ ] OSC 7 でターミナルの CWD を取得
- [ ] `get_focus` の terminal 情報に `cwd` を含める

#### 4.3 「この出力を渡す」UI（Candidate B）
- [ ] ターミナル上に command block の境界を表示
- [ ] command block 単位で「AIに見せる」ボタン
- [ ] 選択した block の command + output + exitCode を scratch に挿入

### セキュリティ注意
- OSC sequence は shell 以外の任意の command も生成可能
- UI grouping / command mark 等の低リスク用途 → そのまま利用可
- ファイル書き込み・command 実行等の高リスク判断 → OSC だけを信頼しない

### 検証
- [ ] PowerShell（PSReadLine OSC 133 対応）で command block が正しく分割されること
- [ ] `get_focus` に terminal CWD が含まれること
- [ ] command block を scratch に挿入してエージェントに送信できること

---

## Phase 5: プレビュー分離（D12）（1日）

### 位置づけ
- D8 の部分撤回。scratch（人間→AI）とプレビュー（AI→人間）は翻訳の方向が逆
- 現状は同じタブバーに統合されており使いにくい

### やること
- [ ] プレビューをエディタペインのタブバーから分離
- [ ] レイアウト案（D12）:
  ```
  [PROJECTS] [ツリー] [ ターミナル ] [プレビュー]
                →     [  scratch  ]      ←
              人間→AI                  AI→人間
  ```
- [ ] プレビューは右側または別ペインに配置
- [ ] scratch と一時タブは入力系タブとして統合維持

### 検証
- [ ] Markdown プレビューが scratch と別の場所に表示されること
- [ ] 既存のプレビュー機能（画像/HTML/MD）が全て動作すること

---

## Phase 6: CodeMirror 6 導入（D9）（2日）

### 位置づけ
- D9 条件成立（行を指差す行為＝空間的指示の翻訳が中核機能）
- 行番号・ガター・行追従が必須

### やること
- [ ] CodeMirror 6 をインストール
- [ ] textarea を CodeMirror に置き換え
  - 行番号表示
  - ガター（行マーク）
  - 行追従（`get_focus` の cursorLine と連動）
- [ ] 歯止め: `package.json` に以下が現れたら違反
  - `@codemirror/lang-*`
  - `@codemirror/autocomplete`
  - LSP 系パッケージ
- [ ] grep で機械的に検出可能

### 検証
- [ ] 行番号が表示されること
- [ ] `get_focus` の cursorLine と CodeMirror のカーソル位置が一致すること
- [ ] シンタックスハイライト無しでも実用的であること

---

## 時期未定: Vue 3 移行（doc 12）

### 位置づけ
- コマンド層が完成した後に検討
- UI に残るのは描画とイベント発火だけになるため、フレームワーク選定の軸は「摩擦が少なく、主役に出しゃばらないか」

### 選定理由（doc 12 より）
- **Vue 3** を選ぶ。理由:
  1. `<KeepAlive>` が標準（ターミナルはアンマウントできない）
  2. xterm.js と CodeMirror 6 は DOM を自分で所有する（非制御領域を作れる）
  3. 毎日使うインフラに学習リスクを載せない

### 注意
- UI コンポーネントライブラリは入れない（専用部品ばかりのため）
- トークン（余白・色・角丸・タイポ）を数個決める程度

---

## 移行判定基準

新版が現行版の日常作業を代替できた日に切り替える。

### チェックリスト
- [ ] ターミナル（Claude Code / Codex / Devin CLI）が全て動作する
- [ ] ファイルツリー・プレビュー・エディタが動作する
- [ ] `get_focus` が実用的に使える
- [ ] スクショ投入が安定する
- [ ] 日常の開発作業を新版だけで完結できる

---

## リスク管理

### 第二システム症候群
- **リスク**: 「全部作り直す」が「動いていたツールが数週間使えなくなり、そのまま停滞する」
- **歯止め**: 現行版を常用したまま並走。下2層を残すため並走が成立する

### WebGL コンテキスト上限
- xterm.js の WebGL アドオンは ターミナル1つにつき WebGL コンテキストを1つ消費
- Chromium の上限（16程度）を超えるとコンテキストロスト
- 23 PTY を抱える PM は踏みうる範囲
- **対策**: 非アクティブタブを canvas/DOM レンダラに落とすか、レンダラを破棄して再作成

### フック設定の上書き問題（doc 11）
- PM が `.claude/settings.json` を上書きすると、共有しているプロジェクトで差分ができる
- **対策**: `.claude/settings.local.json`（gitignore 対象）に書くか、既存内容とマージする形に変更

---

## マイルストーン

| Phase | 内容 | 期間 | ブランチ |
|---|---|---|---|
| 0 | 環境分離 | 0.5日 | v2 |
| 1 | コマンド層 + `get_focus` | 3〜5日 | v2 |
| 2 | スクショ磨き | 1〜2日 | v2 |
| 3 | ツリーフィルタ | 0.5日 | v2 |
| 4 | OSC 133 意味情報 | 2〜3日 | v2 |
| 5 | プレビュー分離 | 1日 | v2 |
| 6 | CodeMirror 6 | 2日 | v2 |
| — | Vue 3 移行 | 未定 | v2 |

**合計（Phase 0〜6）**: 約10〜14日

---

## 参照ドキュメント

- [10_コンセプト（翻訳）](#) — 現行の最上位定義
- [11_決定と根拠 v2](#) — D10〜D15 の決定
- [12_v2アーキテクチャ](#) — 層ごとの判断・ライブラリ選定
- [13_差別化と優先度](#) — 機能ごとの差別化判定
- [14_OSC 133・ターミナル意味情報調査](#) — OSC 133 の詳細調査
