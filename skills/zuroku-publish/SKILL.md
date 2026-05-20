---
name: zuroku-publish
description: HTML + 関連画像を zuroku CLI で publish したい場面で発動。「zuroku に上げて」「グラレコ publish」「explainer をデプロイ」で発動。
license: MIT
metadata:
  author: AI-Driven-R-D-Dept
  version: '0.1.3'
user-invocable: true
argument-hint: <html-path> [image-paths...] --title "..." [--no-compress] [--visibility private|curator] [--private]
allowed-tools: Bash, Read, Edit, Write
---

# zuroku-publish

`zuroku publish` で HTML + 画像をアップロードする手順。AI agent (Claude Code 等) からの呼び出しを想定。

## TL;DR

```bash
# HTML 内の <img src> を `img/<basename>` 形式に揃える (img/ prefix 必須)
mkdir -p /tmp/zuroku-deploy
sed 's|images/|img/|g' /path/to/index.html > /tmp/zuroku-deploy/index.html
cp /path/to/images/*.png /tmp/zuroku-deploy/

cd /tmp/zuroku-deploy
zuroku publish ./index.html ./*.png --title "..."
# - sharp で client-side WebP 圧縮 (85%、長辺 2000px) → 通信量 / 表示も軽量
# - HTML 内 <img src="img/foo.png"> は CLI が自動で .webp に rewrite (v0.1.1+)
# - 標準出力の最終行が公開 URL

# 自分だけが見える private で上げたい場合
zuroku publish ./index.html ./*.png --title "..." --private
```

## 制約

### R1. HTML の image src は `img/<basename>` に統一
- 配信ルートが `/p/:slug/img/:filename` 固定。HTML 側は相対 `<img src="img/foo.png">` で参照する。
- `images/`、`./assets/` 等で書かれていれば publish 前に sed で書き換える。
- SVG (`<img src="img/foo.svg">`) は受け付けない。PNG / JPEG / WebP / GIF のみ。

### R2. 圧縮 (default ON、client-side で軽量化される)
- default で sharp が PNG/JPEG → WebP 85%、長辺 max 2000px に変換 (帯域 / 表示の両方で大幅軽量化)。
- 拡張子 `.png` → `.webp` の rename が発生するが、**HTML 内 `<img src="img/foo.png">` は CLI が自動で `.webp` に rewrite する** (v0.1.1+)。AI agent 側で sed は不要。
- `--no-compress` を付けると original のまま upload (filename 不変、HTML も触らず)。サイズが大きい時は事前リサイズしないと R3 に当たる。
- GIF はアニメ保持のため compress でも passthrough (filename 不変)。

### R3. サイズ上限
- HTML: 5 MiB
- asset 1 ファイル: 5 MiB
- 1 日: 50 publish / 500 MB

### R4. visibility (公開範囲)
- `-V, --visibility <mode>`: `private` (本人のみ) / `curator` (curator role を持つ Discord メンバーのみ閲覧可) / `public` (リンクを知る誰でも閲覧可)。
- `--private`: `--visibility private` のショートカット。`-V curator` と併用された場合は `--private` が勝つ (CLI が warn を出す)。
- どちらも未指定なら順に下記の優先順で解決:
  1. CLI flag (`--private` > `--visibility`)
  2. `~/.config/zuroku/config.json` の `default_visibility` (`zuroku config set default-visibility ...`)
  3. server default = `curator`
- **`public` は per-publish で指定可能** (`--visibility public`)。リンクを知る誰でも閲覧できるが、アプリ内 timeline/検索には出さず `X-Robots-Tag: noindex,nofollow` で配信される (リンク共有 / SNS unfurl 用、SEO index はしない)。
  - ただし **`public` を `config set default-visibility` のデフォルトには保存できない** (公開は毎回明示的に選ぶべきで、暗黙のデフォルトにはしない設計)。
- private のまま publish 後に visibility を変えたいときは stderr に表示される `manage visibility: <app>/settings/projects` の URL から切り替える (Web UI からは public への切替も可)。

## CLI が publish 前に弾くケース

`zuroku publish` は HTML を parse して `<img src="img/...">` と asset 引数の整合性を検査し、不一致なら `INVALID_INPUT` で fail-fast する。stderr に詳細メッセージが出るので、AI agent はタグを見て対処する。

| タグ | 意味 | 対処 |
|---|---|---|
| `[MISSING]` | HTML が参照しているが asset 引数にない file | `--no-compress` 漏れ or rename ミス |
| `[UNUSED]` | asset 引数にあるが HTML 未参照 | 余分な image を引数から外す |
| `[WRONG-PATH]` | `img/` で始まらない相対参照 | sed で `images/` → `img/` 等に書換 |

緊急 bypass: `ZUROKU_SKIP_PREFLIGHT=1 zuroku publish ...` (debug 用、本番では使わない)。

### R6. 外部 subresource の hotlink protection (v0.1.5+, 自動)

zuroku CLI は publish/update 時に HTML を scan し、`<img src="https://...">` と
`<iframe src="https://...">` に `referrerpolicy="no-referrer"` が無ければ
自動付与する。理由:

- 配信ドメイン (例: `app.zuroku.masao.ai`) を Referer に載せると、X / 一部 CDN /
  報道サイトの hotlink protection が **403 / placeholder** を返す。
- `curl` / `fetch(url)` だと 200 が返るので「URL は生きている」と誤認しがちだが、
  ブラウザ subresource として読むと壊れる。**初見エージェントが最も機械的に踏む罠**。
- 自動付与時は stderr に `info  html: added referrerpolicy="no-referrer" to N external <img>/<iframe>` が出る。
- 既に `referrerpolicy` が指定済みで値が `no-referrer` 以外 (`origin` / `unsafe-url` 等) なら
  CLI は **書き換えず warn を出す** (誤設定の hint)。

スコープ外:
- `<a href="https://...">` (ナビゲーションは hotlink 制限の対象外)
- `img/<basename>` (zuroku asset。同一 origin)
- `data:` / `blob:` URI

### R5. local-path leak preflight (v0.1.3+)

preflight は asset 参照だけでなく **HTML 全体を text として scan** し、viewer 環境では絶対に解決しない作者マシン path を見つけたら `LOCAL_PATH_LEAK` で fail-fast する:

| pattern | severity | 例 |
|---|---|---|
| `/Users/<name>/...` | error | macOS の個人 home |
| `/home/<name>/...` | error | Linux の個人 home |
| `file://...` | error | local file URI |
| `C:\Users\...` / `Documents\` / `Desktop\` | error | Windows の個人 path |
| `/var/folders/...` | error | macOS の TMPDIR layout |
| `~/...` | warn | warn のみ、publish は通る |

検知された場合は **HTML 側を直して** から再 publish する (絶対パスを削除 / 公開 URL に置換 / ファイル名だけ抽象的に言及)。`<code>` ブロックや本文中の引用にも leak しやすい。

## update (republish) — slug を維持して上書き (v0.1.3+)

```bash
# slug でも id でも OK。HTML auto-rewrite / preflight は publish と同じ。
zuroku update my-cool-page ./index.html ./img/*.png
```

- 既存 project の HTML と asset を **完全置換** して同じ slug / URL で再公開する (`-2` は付かない)。
- asset は **全置換**。残したい画像も含めて positional 引数で渡すこと (省略すると 0 件で送られる)。
- 新しい URL を発行したい場合は `update` でなく `publish` を使う。
- 内部的には `republish-init` → `uploadHtml`/`uploadAsset` (新 token) → `republish` の 3 段階。失敗しても manifest swap (3 段目) までは旧版が viewer に出続ける。

### `--keep-assets` — 本文だけ直して画像はそのまま (v0.1.5+)

```bash
# HTML だけ差し替え、既存の画像は一切触らない。img 引数は不要 (渡しても無視)。
zuroku update my-cool-page ./index.html --keep-assets
```

- 既存画像を **温存** したまま HTML だけ更新する。全置換モードと違い画像の再アップロード不要。
- 「文言だけ直したい」「typo 修正」など本文のみの更新で、画像の渡し忘れによる一括削除事故を防げる。
- asset 欠落 preflight はスキップされる (HTML が参照する `img/*` はサーバ側に温存されている前提)。
- thumbnail / OG 画像も従来のまま維持される。
- 画像を **足す / 差し替える / 消す** ときは `--keep-assets` を付けず、全画像を positional で渡す全置換モードを使う。

## 認証

```bash
# Web UI で API key 発行 → 平文 token をコピー → CLI に登録
zuroku auth login --token zrk_live_xxx --base-url https://app.zuroku.masao.ai
```

token は HMAC で server 保存、平文は発行時 1 回だけ表示される。

## config (per-user 既定値)

```bash
zuroku config set default-visibility private    # 既定を private に
zuroku config set default-visibility curator    # 既定を curator に戻す
zuroku config unset default-visibility          # config 削除 → server default 'curator'
zuroku config get default-visibility            # 現在値を stdout に
zuroku config get                               # 一覧
```

config は `~/.config/zuroku/config.json` に `0600` で保存される (`XDG_CONFIG_HOME` 尊重)。
`default-visibility` に設定できるのは `private` / `curator` のみ。**`public` は `set` で reject される** (公開は per-publish で `--visibility public` を明示する設計で、暗黙のデフォルトにはしない)。`publish` は flag 未指定時に config を fallback する (info 行 `visibility: <mode> (from config default_visibility)` が出る)。

## list / delete

```bash
zuroku list              # 自分の publish 一覧
zuroku delete <slug>     # soft delete
zuroku delete <slug> -y  # 確認スキップ
```

soft delete 後に同じ slug を再 publish すると `<slug>-2` が自動採番される。

## 出力 contract

`zuroku publish` の **stdout 最終行は bare URL のみ**。進捗 / info / success は stderr に出る。

```bash
URL=$(zuroku publish ./index.html ./img/*.png --title "..." 2>/dev/null | tail -1)
```

## 失敗パターン早見表

| 症状 | 原因 | 対処 |
|---|---|---|
| `INVALID_INPUT [MISSING]` | HTML 内 src と asset の filename 不一致 | preflight メッセージの Suggested fixes を読む |
| `LOCAL_PATH_LEAK` | HTML 本文に `/Users/...` 等の作者マシン path が混入 (v0.1.3+ で検知) | HTML 側で絶対パスを削除 / 公開 URL に置換 / ファイル名だけ抽象的に言及 |
| 公開ページで外部画像だけ 403 / placeholder | hotlink protection (Referer 検査) | v0.1.5+ は自動付与。**warn 行 `referrerpolicy="..." (recommended: "no-referrer")` が出たら** HTML 側を `no-referrer` に直す。`<a>` には不要 |
| 配信ページで画像 404 | (v0.1.1+ では自動 rewrite される。それ以前 / HTML を直接書き換えていた場合) basename 不一致。HTML の `<img src="img/...">` と asset 引数の filename を再確認 |
| `UNSUPPORTED_MEDIA 415` | SVG / Content-Type 偽装 | PNG/JPEG/WebP/GIF のみ |
| `BODY_TOO_LARGE 413` | ファイル 5 MiB 超過 | 事前リサイズ |
| `QUOTA_EXCEEDED 429` | 1 日上限超過 | 翌 UTC midnight まで待つ |
| `AUTH_INVALID 401` | token revoked / expired / typo | Web で再発行 + `zuroku auth login` |
| `NOT_CURATOR 403` | curator role を Discord で剥奪された | role 復帰 (反映まで最大 60 秒) |
