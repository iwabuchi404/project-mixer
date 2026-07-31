# ファイルプレビュー機能 設計ドキュメント

## 1. 概要

Project Mixer にファイルプレビュー機能を追加する。画像・Markdown・HTML をブラウザ（Electron の `<webview>`）で表示し、既存のテキストエディタタブと統合されたタブUIで扱う。

### 目的
- ファイルツリーから画像・Markdown・HTML を素早くプレビュー表示したい
- 外部ビューアを開かずにアプリ内で確認できるようにしたい
- 既存のタブシステムと統合し、編集タブと並行してプレビューを開けるようにしたい

### スコープ
- 対象: 画像 / HTML / Markdown の読み取り専用プレビュー
- 対象外: PDF、動画、音声、Office文書等（将来的拡張候補）
- 対象外: Markdown のライブスプリット編集プレビュー（今回は読み取り専用）

## 2. 設計判断

| 項目 | 採用 | 理由 |
|---|---|---|
| レンダリング方式 | `<webview>` で統一 | 画像/HTML/MD 全てを1つの仕組みで扱える。`file://` ロード可能で相対パス解決もできる。iframe は CSP・file:// 制限があり不適 |
| 開き方 | ダブルクリック自動振り分け ＋ コンテキストメニュー「Preview」 | 直感的な操作と明示的操作の両方を提供 |
| Markdown 表示 | 読み取り専用プレビュー | 編集は既存テキストエディタで可能。スプリット表示は実装量が増えるため今回は見送り |
| Markdown パーサ | `marked` + `dompurify` | marked は HTML をサニタイズしない（sanitize オプションは廃止済み、公式が DOMPurify 併用を推奨）。エージェント生成物・クローン元 README など信頼できない入力を扱うため二重防衛とする |
| プレビュー領域 | 既存 `#editor-content` 内に webview を同居 | タブシステムをそのまま流用でき、UIの一貫性が保てる |

### webview 採用の補足
- Electron では `<webview>` は将来的に非推奨の方向だが、現状動作する
- 代替（`BrowserView` / `WebContentsView`）はタブ統合が複雑になり「最低限実装」の趣旨から外れる
- file:// ロードや独立プロセスレンダリングのため iframe より適する

### セキュリティ設計（重要）
プレビュー対象の HTML / Markdown は**信頼できない入力**である。主用途は「AI エージェントが生成したファイル」「クローンしてきたリポジトリの README」であり、定義上これらは信頼できない。本アプリは5〜10プロジェクト分の PTY を抱えており、file:// オリジンでスクリプトが動くと被害範囲が広い。そのため以下の多層防御を取る。

1. **webview のサンドボックス化**
   - `partition="persist:preview"` でストレージ・Cookie をアプリ本体と分離
   - `webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"` を指定
   - `allowpopups` は付けない
2. **Markdown のサニタイズ**
   - `marked.parse()` は生 HTML をそのまま通す（`<script>` が動く）。sanitize オプションは廃止済み
   - 公式推奨通り `DOMPurify.sanitize(marked.parse(content))` を通す
   - sandbox 済み webview でも実害は下がるが、両方やるのが安全
3. **HTML プレビュー**
   - file:// 直読みなので marked/DOMPurify の経路を通らない
   - sandbox webview のみで防御。スクリプトは動くが file:// オリジン内に閉じ、partition 分離済み

## 3. 対応ファイル種別

| 種別 | 拡張子 | 表示方法 |
|---|---|---|
| 画像 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.bmp` `.ico` | webview に `file://` パスを直接ロード (`webview.src`) |
| HTML | `.html` `.htm` | webview に `file://` パスを直接ロード (`webview.src`) |
| Markdown | `.md` `.markdown` | `DOMPurify.sanitize(marked.parse(content))` で HTML 変換 → `<base href>` とGitHub風CSSを埋め込んだ data URLを `webview.src` に設定 |

## 4. アーキテクチャ

### 4.1 既存構造（参考）

```
#editor-pane
  #editor-tab-bar
    .editor-tab (scratch / temp / file)
  #editor-content
    <textarea id="editor-textarea">
  #send-bar
```

- `openFiles: Map<path, { path, name, content, originalContent, tabEl, isScratch, isTemp }>`
- `openFileInEditor(filePath, name)`: テキストファイルをタブで開く
- `switchEditorTab(filePath)`: タブ切替時に textarea に内容を反映

### 4.2 変更後構造

```
#editor-pane
  #editor-tab-bar
    .editor-tab (scratch / temp / file / preview)
  #editor-content
    <textarea id="editor-textarea">       ← テキスト編集タブ時に表示
    <webview id="preview-webview" hidden> ← プレビュータブ時に表示
  #send-bar
```

- `openFiles` の要素に `isPreview: boolean` フラグを追加
- `openFileInPreview(filePath, name)`: プレビュータブを生成（既存 `openFileInEditor` と並列）
- `switchEditorTab` 拡張: `isPreview` の有無で textarea / webview を切り替え

### 4.3 データフロー

```
[ダブルクリック / コンテキストメニュー]
        |
        v
  拡張子判定 (isPreviewable)
        |
        +-- previewable --> openFileInPreview(path, name)
        |                       |
        |                       v
        |                   タブ生成 (isPreview: true)
        |                       |
        |                       v
        |                   switchEditorTab(path)
        |                       |
        |                       v
        |                   種別判定 → webview にロード
        |                       |
        |                       +-- image  --> webview.src = "file://..."
        |                       +-- html   --> webview.src = "file://..."
        |                       +-- md     --> webview.src = data:text/html,...
        |
        +-- その他 -----> openFileInEditor (従来通り)
```

## 5. 実装ステップ

### 5.1 依存追加
- `npm install marked dompurify`
- `package.json` の `dependencies` に `marked` と `dompurify` が追加される
- `index.html` で `<script src="./node_modules/marked/marked.min.js">` と `<script src="./node_modules/dompurify/dist/purify.min.js">` を読み込み
- `package.json` の `build.files` には既に `node_modules/**/*` が含まれるため配布設定の追加不要

### 5.2 `main.js`
- `createWindow()` の `webPreferences` に `webviewTag: true` を追加

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: true,           // ← 追加
},
```

### 5.3 `index.html`
- `#editor-content` 内に `<webview>` を追加（サンドボックス設定済み）
- コンテキストメニューに「Preview」項目を追加

```html
<div id="editor-content">
  <textarea id="editor-textarea" spellcheck="false" wrap="off"></textarea>
  <webview id="preview-webview"
           class="hidden"
           partition="persist:preview"
           webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes">
  </webview>
</div>
```

```html
<div id="context-menu" class="context-menu hidden">
  <div class="context-menu-item" data-action="open">Open in Editor</div>
  <div class="context-menu-item" data-action="preview">Preview</div>   <!-- ← 追加 -->
  <div class="context-menu-item" data-action="insert-path">Insert Path to Terminal</div>
  <div class="context-menu-item" data-action="insert-name">Insert Filename to Terminal</div>
</div>
```

### 5.4 `renderer.js`

#### 拡張子判定ヘルパ
```js
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
const HTML_EXTS  = ['.html', '.htm'];
const MD_EXTS    = ['.md', '.markdown'];

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
function isImage(name)    { return IMAGE_EXTS.includes(getExt(name)); }
function isHtml(name)     { return HTML_EXTS.includes(getExt(name)); }
function isMarkdown(name) { return MD_EXTS.includes(getExt(name)); }
function isPreviewable(name) {
  return isImage(name) || isHtml(name) || isMarkdown(name);
}
```

#### `openFileInPreview(filePath, name)`
- 既存 `openFileInEditor` と同形だが、`isPreview: true` を設定
- content は MD のときだけ `readFile` で取得（画像・HTML は webview が file:// で直接読むため不要だが、統一性のため MD のみ取得）
- タブの見た目は通常タブと同じ（必要ならアイコンやクラスで差別化）

#### `switchEditorTab` 拡張
```js
function switchEditorTab(filePath) {
  const f = openFiles.get(filePath);
  if (!f) return;

  openFiles.forEach((fd) => fd.tabEl.classList.remove('active'));
  f.tabEl.classList.add('active');
  activeFilePath = filePath;

  if (f.isPreview) {
    editorTextarea.classList.add('hidden');
    previewWebview.classList.remove('hidden');
    loadPreviewContent(f);
  } else {
    previewWebview.classList.add('hidden');
    previewWebview.src = 'about:blank';   // 直前の内容を破棄
    editorTextarea.classList.remove('hidden');
    editorTextarea.value = f.content;
    if (!f.isScratch) updateEditorDirty(filePath);
    editorTextarea.focus();
  }
}
```

#### `loadPreviewContent(fileData)`
```js
const MD_CSS = `/* GitHub風 最小限スタイル */ ...`;

function toFileUrl(p) {
  // Windows: D:\path -> file:///D:/path
  return 'file:///' + p.replace(/\\/g, '/');
}

function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

async function loadPreviewContent(f) {
  if (isImage(f.name)) {
    previewWebview.src = toFileUrl(f.path);
  } else if (isHtml(f.name)) {
    previewWebview.src = toFileUrl(f.path);
  } else if (isMarkdown(f.name)) {
    const result = await window.api.readFile(f.path);
    if (!result.success) return;
    const html = DOMPurify.sanitize(marked.parse(result.content));
    const baseUrl = toFileUrl(dirname(f.path)) + '/';
    const documentHtml = `<!DOCTYPE html>
      <html><head><meta charset="UTF-8"><base href="${baseUrl}"><style>${MD_CSS}</style></head>
      <body class="markdown-body">${html}</body></html>`;
    previewWebview.src = `data:text/html;charset=UTF-8,${encodeURIComponent(documentHtml)}`;
  }
}
```
- `MD_CSS` は GitHub風の最小限スタイルを定数として定義
- Windows パスの `file://` 変換は `toFileUrl(p)` で統一
- Markdown の相対リンク・画像参照は `<base href>` で解決。スクショの `![](./tmp/shot.png)` のような相対参照が主用途のため必須

#### ダブルクリックハンドラ
- 既存のツリーアイテムクリック処理に dblclick を追加
- `isPreviewable(name)` なら `openFileInPreview`、それ以外は `openFileInEditor`

#### コンテキストメニュー「Preview」
- `data-action="preview"` のクリックハンドラを追加
- `openFileInPreview(contextMenuEntry.path, contextMenuEntry.name)` を呼ぶ
- プレビュー不可能な拡張子のときは無効化または非表示（任意）

#### `closeEditorTab`
- `isPreview` フラグを見て分岐
- クローズ時にアクティブタブがプレビューだった場合の後処理は既存ロジックで対応可能（`switchEditorTab(SCRATCH_PATH)` にフォールバック）

### 5.5 `styles.css`
- `#preview-webview` のサイズ・枠線など最小限のレイアウト調整
- `#editor-content` に `position: relative` が必要か確認（webview の fill 制御）
- webview は `flex: 1; width: 100%; height: 100%;` 程度で対応

```css
#editor-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
#editor-textarea {
  flex: 1;
  /* 既存スタイル */
}
#preview-webview {
  flex: 1;
  border: none;
  background: #1e1e1e;
}
#preview-webview.hidden { display: none; }
```

### 5.6 `preload.js`
- 既存 `readFile` で対応可能
- 新規 IPC チャネル不要

## 6. 懸念点・注意事項

| 項目 | 内容 | 対応 |
|---|---|---|
| webview の非推奨化 | Electron で将来的に非推奨方向 | 現状動作するため採用。将来的に WebContentsView へ移行 |
| file:// パス変換 | Windows の `D:\path` → `file:///D:/path` | ヘルパ関数 `toFileUrl(p)` で統一 |
| Markdown の相対リンク | MD 内の相対リンク・画像参照 | `<base href="${toFileUrl(dirname(f.path))}/">` で解決。スクショの `![](./tmp/shot.png)` 等の主用途が壊れるため必須対応 |
| 信頼できない HTML/MD | 主用途がエージェント生成物・クローン README。file:// オリジンでスクリプトが動くと PTY 群への被害が広がる | 多層防御: sandbox webview (partition 分離) + DOMPurify (MD) |
| webview が1つのみ | タブ切替のたびに src を再設定するためスクロール位置・JS状態がリセットされる | v1 はこのままでよい。I2（インタラクティブHTML）に進むときは「タブごとに webview を持つ」設計に変更が必要。その際プロセス数 40〜80MB/タブ が S2（リソース制約）に効く |
| 大きな画像 | 数十MBの画像表示 | ブラウザ任せ。問題あればサイズ制限を検討 |

## 7. 検証項目

- [ ] 画像（png/jpg/gif/svg/webp）が表示される
- [ ] HTML ファイルがレンダリングされる（相対パスのCSS/画像も解決される）
- [ ] Markdown が GitHub風にレンダリングされる
- [ ] Markdown 内の相対画像参照（`![](./tmp/shot.png)`）が解決される
- [ ] Markdown に `<script>` を仕込んだ場合に実行されない（DOMPurify 効果）
- [ ] ダブルクリックで拡張子に応じてプレビュー/エディタが振り分けられる
- [ ] コンテキストメニュー「Preview」で明示的にプレビューできる
- [ ] プレビュータブとエディタタブを並行して開ける
- [ ] タブのドラッグ並び替えがプレビュータブでも動作する
- [ ] プレビュータブを閉じた後、別タブに正しく切り替わる
- [ ] アプリ再起動後もクラッシュしない（レイアウト保存・復元との整合性）
- [ ] プレビュータブを複数開いた状態でのメモリ使用量（S2 未計測のため要計測）

## 8. 将来拡張候補

- PDF プレビュー（`<webview>` で PDF.js または Electron の内蔵ビューア）
- **タブごとに webview を持つ構成への移行**（I2 のインタラクティブHTML本命に向けた前提作業。プロセス数増による S2 影響を先に評価する必要あり）
- プレビューの更新ボタン（ファイル変更時の再レンダリング）
- ファイル変更の自動リロード（fs.watch で監視）
- コードハイライト（highlight.js を MD プレビューに統合）※ D7 drift 注意: MD プレビュー内に閉じるなら許容範囲だが「エディタ側にも欲しい」に繋がる典型経路。やる場合は D7 の見直しとセット
- Markdown スプリット編集プレビュー ※ D9 衝突: 明確にエディタ方向。「I1 着手まで textarea のまま」と衝突するため、やる場合は D9 の見直しが必須
- WebContentsView への移行（webview 非推奨化への備え）
