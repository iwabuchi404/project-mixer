# セッション履歴表示 計画

**作成日**: 2026-09-27
**更新日**: 2026-10-19（H1実装、実装メモ追記）
**位置づけ**: Phase 8（マルチペイン）完了後の新規機能。フェーズ番号は未採番
**前提調査**: 4エージェントのセッション保存形式を実機で確認済み（下記「データソース実査」）
**状態**: H1実装済み（スキャナ / IPC / コマンド / 一覧タブUI）。H2トランスクリプト未着手

---

## 概要

各エージェント（claude / codex / opencode / devin）の過去セッションをアプリ内に一覧表示し、選択したセッションを resume で再開できるようにする。段階2として、セッションの会話内容（トランスクリプト）をアプリ内で閲覧できるビューアを追加する。

### 目的

- 「あの時のセッション」を探して再開する導線を短くする。現状はプロジェクト＋コマンドごとに**直近1件**しか記憶していない（`rememberAgentSession` → localStorage）
- 再開せず参照だけしたい場合にも、外部ツールなしで過去のやり取りを読めるようにする

### スコープ

| | 扱う | 扱わない |
| --- | --- | --- |
| 対象エージェント | claude / codex / opencode / devin（4つ全部） | その他 CLI |
| 表示 | 一覧（タイトル・日時・プロバイダ）＋ resume、段階2でトランスクリプト閲覧 | セッション削除・検索・編集・分岐 |
| UI | 専用タブ（既存の非ターミナルタブ機構 `nonTerminalTabs` に載せる） | 常時ポーリングのライブ更新（手動リフレッシュのみ） |
| データ | 各エージェントのローカル保存 / Devin API を**読むだけ** | 独自セッションDBの新設（`pm-last-agent-sessions` は resume 用に現状維持） |

---

## データソース実査（2026-09-27 実機確認）

| Agent | 保存場所 | 一覧に必要な情報 | resume |
| --- | --- | --- | --- |
| claude | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | sessionId=ファイル名、各行に `timestamp`/`cwd`、タイトルは最初の `type:"user"` の `message.content` から抽出 | `claude --resume <id>` |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | 先頭行 `session_meta` に `session_id`/`cwd`/`timestamp`。日付ツリーのため **cwd フィルタ必須** | `codex resume <id>` |
| opencode | `~/.local/share/opencode/project/<slug>/storage/session/info/ses_*.json` | `{id, title, time:{created, updated}}` が直接取れる。**最も楽** | `opencode -s <id>` |
| devin | `GET https://api.devin.ai/v3/organizations/{org}/sessions` | APIの一覧レスポンス。cwd 紐付けは無い可能性あり（org 単位の一覧になる見込み） | `devin -r <id>` |

トランスクリプト用の内部構造（段階2）:

- **claude**: jsonl 1行=1イベント。`user`/`assistant` の `message.content`（文字列 or block配列）を拾う。`system`/`bridge-session`/`isSidechain`/tool_result 等のノイズ除去が必要。1ファイルが数MBになりうる
- **codex**: `session_meta` 以降は `response_item` 系列の独自スキーマ（message/reasoning/function_call）
- **opencode**: `info` → `message/<ses>/<msg>.json`（role/time）→ `part/<ses>/<msg>/prt_*.json`（`type:"text"` 等）の3層ファイルツリー。組み立ての手間は最大だがスキーマは最もクリーン
- **devin**: `GET .../sessions/{id}` のレスポンス内メッセージ（既存 `DevinSessionMonitor` と同じ認証を再利用）

---

## 設計判断

| 項目 | 採用 | 理由 |
| --- | --- | --- |
| 正規化モデル | main 側で `{ provider, sessionId, title, createdAt, updatedAt }` に統一して返す | renderer は1種のリストだけ描けばよい。プロバイダ差は main に閉じ込める |
| スキャナ配置 | 新規 `src/main/session-history.cjs` | 既存 `resume-args.cjs` / `devin-session-monitor.cjs` と同じ src/main 配下。ホーム外ファイルアクセスは main のみが行い、renderer には正規化済みデータだけ渡す |
| UI 載せ先 | 非ターミナルタブ（`nonTerminalTabs`） | 検索タブの先例があり、保存・復元・ペイン分割の仕組みをそのまま使える |
| resume 配管 | 既存 `create_terminal` の `resumeSessionId` に流す | `buildResumeArgs` が4者分のフラグ生成を済ませている。新規コードほぼ不要 |
| 起動経路 | コマンド `session_history`（`COMMAND_TYPES` に登録）＋ UI ボタン | コマンド層の規律（D10）に従う。定義漏れは renderer 全体を停止させるため回帰テスト対象に含める |
| トランスクリプト描画 | 構造化DOM（role ごとのブロック）で組み立て、テキスト部のみ marked + dompurify | 依存に既に両方ある。生 HTML 流し込みはしない（エージェント出力は信頼できない入力） |
| 防御的パース | フォーマット解釈失敗時はそのプロバイダだけ空配列で返す | 全プロバイダの形式が非公開・バージョン依存。壊れても一覧自体は生かす |

---

## 実装順

難易度見積もりは「一覧+resume=中（~300〜400行＋テスト）、トランスクリプト=その2〜3倍」。

### H1: 一覧 + resume（先に入れる）

| # | 作業 | 対象ファイル |
| --- | --- | --- |
| 1 | `src/main/session-history.cjs` — 4プロバイダのスキャナ。claude の cwd→slug 変換、codex の session_meta 先頭行読み＋cwdフィルタ、opencode info JSON 読み、devin list API（`DevinSessionMonitor` の認証を再利用） | 新規 |
| 2 | IPC `sessions:list { cwd }` + preload 公開 | `main.js`, `preload.js` |
| 3 | `session_history` コマンドを `COMMAND_TYPES` に登録＋ハンドラ | `src/commands/types.js`, `renderer.js` |
| 4 | 一覧タブ UI。プロバイダ別グループ表示、行クリックで `dispatch('create_terminal', { command, cwd, projectId, resumeSessionId })` | `renderer.js`, `index.html`, `styles.css` |
| 5 | テスト `test/session-history.test.cjs` — fixture ディレクトリでパース・slug化・cwdフィルタ・壊れた入力の耐性 | `test/fixtures/` 利用 |

### H2: トランスクリプト閲覧（H1 のタブに載せる）

| # | 作業 |
| --- | --- |
| 1 | 正規化モデル `{ role, timestamp, text, kind }` を定義 |
| 2 | プロバイダ別パーサを1つずつ追加（opencode → claude → codex → devin の順が組み立てやすさ順） |
| 3 | 一覧の行クリックでタブ内詳細ビューを開く。tool呼出しは折りたたみ表示 |
| 4 | 各パーサの fixture テスト追加 |

---

## リスク・留意点

| リスク | 対処 |
| --- | --- |
| 全形式が非公開・バージョン依存（claude `2.1.x`、opencode `0.3.x` 等で確認） | 未知の type はスキップ、必須フィールド欠落でそのプロバイダだけ空。fixture テストで現行形式を固定 |
| claude jsonl が数MBに育つ | 一覧用は「最初の user メッセージまで」で打ち切り読み。トランスクリプト読みはオンデマンド |
| opencode が `opencode.db`（SQLite）へ移行中の形跡あり | `storage/` を優先で読み、存在しない場合は空を返す。db 直接参照はしない |
| devin セッションに cwd が無い | プロジェクトフィルタを外して org 全体の直近を出す設計にしておく（要実測） |
| コマンド定義漏れで renderer 全体が停止 | `COMMAND_TYPES` 登録を実装と同コミットに。既存の回帰テストが検出する |

---

## 実装メモ（2026-10-19 実機確認に基づく計画からの確定事項）

- **スラグ照合はcase非依存**: claude・opencodeとも、起動時のcwd文字列からスラグを生成するためドライブ文字の大小が揺れる（実例: `D:\work\kamox` → `d--work-kamox`）。ディレクトリを列挙してcase-insensitive照合する。Windows NTFSはcase-insensitiveなため完全一致でも偶然動くが、macOS/Linuxで欠落する
- **opencodeは info JSON にpath無し**: プロジェクト帰属はディレクトリ名スラグのみ。スラグ照合でフィルタし、`global` 等の非プロジェクトディレクトリは除外される
- **codex旧形式はスキップ**: 2026-07頃のrolloutは先頭行が `{id, timestamp}` でcwdを持たない。帰属できないため表示しない（「cwdフィルタ必須」を優先し、他プロジェクトへの漏出を避ける）。現行形式は `{type:'session_meta', payload:{session_id, cwd, ...}}`
- **claude/codexのupdatedAtはファイルmtime**: 一覧が「最新activity順」でソートされる。createdAtはjsonl内timestamp / session_metaから
- **実装配置**: `src/main/session-history.cjs`（スキャナ）、`sessions:list` IPC（cwd検証は `devin:latest-session` と同様に `isSafeCwd` + `resolveProjectRoot`）、`session_history` コマンドでSessionsタブ（`nonTerminalTabs` type `sessions`、レイアウト保存・復元対応）。プロジェクト切替時はタブを閉じる（searchタブと同じ挙動）

---

## 完了条件

- H1: 一覧タブで4プロバイダのセッションが出る。行選択で resume ターミナルが開く。`npm test` + `npm run build:renderer` 通過 + 実機起動確認
- H2: 行クリックで会話内容が読める。tool呼出しが畳め、テキストがサニタイズ済みで描画される
