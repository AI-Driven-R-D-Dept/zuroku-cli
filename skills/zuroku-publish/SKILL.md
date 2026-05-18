---
name: zuroku-publish
description: HTML + 関連画像を zuroku CLI で publish したい場面で発動。「zuroku に上げて」「グラレコ publish」「explainer をデプロイ」で発動。
user-invocable: true
argument-hint: <html-path> [image-paths...] --title "..." [--no-compress] [--visibility private|curator] [--private]
allowed-tools: Bash, Read, Edit, Write
---

# zuroku-publish

`zuroku publish` で HTML + 画像をアップロードする手順。AI agent (Claude Code 等) からの呼び出しを想定。

## TL;DR

```bash
# HTML 内の <img src> を `img/<basename>` に揃える
mkdir -p /tmp/zuroku-deploy
sed 's|images/|img/|g' /path/to/index.html > /tmp/zuroku-deploy/index.html
cp /path/to/images/*.png /tmp/zuroku-deploy/

cd /tmp/zuroku-deploy
zuroku publish ./index.html ./*.png --title "..." --no-compress

# 自分だけが見える private で上げたい場合
zuroku publish ./index.html ./*.png --title "..." --private

# 標準出力の最終行が公開 URL
```

## 制約

### R1. HTML の image src は `img/<basename>` に統一
- 配信ルートが `/p/:slug/img/:filename` 固定。HTML 側は相対 `<img src="img/foo.png">` で参照する。
- `images/`、`./assets/` 等で書かれていれば publish 前に sed で書き換える。
- SVG (`<img src="img/foo.svg">`) は受け付けない。PNG / JPEG / WebP / GIF のみ。

### R2. 圧縮 (`--no-compress`)
- default は sharp で PNG/JPEG → WebP 85% に変換し、長辺 max 2000px。**filename 拡張子も `.webp` に変わる**。
- HTML 側 `<img src="img/foo.png">` のままだと配信時 404 になる。圧縮するなら HTML を先に `.webp` に書き換える。
- `--no-compress` を付ければ filename 不変 (HTML を触らずに済む。サイズが大きい場合は事前リサイズ推奨)。
- GIF はアニメ保持のため compress しても passthrough される。

### R3. サイズ上限
- HTML: 5 MiB
- asset 1 ファイル: 5 MiB
- 1 日: 50 publish / 500 MB

### R4. visibility (公開範囲)
- `-V, --visibility <mode>`: `private` (本人のみ) / `curator` (curator role を持つ Discord メンバーのみ閲覧可)。
- `--private`: `--visibility private` のショートカット。`-V curator` と併用された場合は `--private` が勝つ (CLI が warn を出す)。
- どちらも未指定なら順に下記の優先順で解決:
  1. CLI flag (`--private` > `--visibility`)
  2. `~/.config/zuroku/config.json` の `default_visibility` (`zuroku config set default-visibility ...`)
  3. server default = `curator`
- **`public` は server 予約語**で、CLI も server も reject する。一般公開したい場合は curator にした上で Web UI から個別操作する。
- private のまま publish 後に visibility を変えたいときは stderr に表示される `manage visibility: <app>/settings/projects` の URL から切り替える。

## CLI が publish 前に弾くケース

`zuroku publish` は HTML を parse して `<img src="img/...">` と asset 引数の整合性を検査し、不一致なら `INVALID_INPUT` で fail-fast する。stderr に詳細メッセージが出るので、AI agent はタグを見て対処する。

| タグ | 意味 | 対処 |
|---|---|---|
| `[MISSING]` | HTML が参照しているが asset 引数にない file | `--no-compress` 漏れ or rename ミス |
| `[UNUSED]` | asset 引数にあるが HTML 未参照 | 余分な image を引数から外す |
| `[WRONG-PATH]` | `img/` で始まらない相対参照 | sed で `images/` → `img/` 等に書換 |

緊急 bypass: `ZUROKU_SKIP_PREFLIGHT=1 zuroku publish ...` (debug 用、本番では使わない)。

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
`public` は server 予約のため `set` でも reject される。`publish` は flag 未指定時に config を fallback する (info 行 `visibility: <mode> (from config default_visibility)` が出る)。

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
| 配信ページで画像 404 | sharp 圧縮で filename が `.webp` に変わったが HTML 未更新 | `--no-compress` で再 publish or HTML を sed で書き換え |
| `UNSUPPORTED_MEDIA 415` | SVG / Content-Type 偽装 | PNG/JPEG/WebP/GIF のみ |
| `BODY_TOO_LARGE 413` | ファイル 5 MiB 超過 | 事前リサイズ |
| `QUOTA_EXCEEDED 429` | 1 日上限超過 | 翌 UTC midnight まで待つ |
| `AUTH_INVALID 401` | token revoked / expired / typo | Web で再発行 + `zuroku auth login` |
| `NOT_CURATOR 403` | curator role を Discord で剥奪された | role 復帰 (反映まで最大 60 秒) |
