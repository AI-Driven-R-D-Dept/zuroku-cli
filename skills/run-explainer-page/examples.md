# run-explainer-page examples

## 参考の最終成果物

`/Users/masao/playground/codex-image-editor/explainer/index.html` (482 行)

- hero: kicker `CODEX APP SERVER 解説` + h1 + lede + TL;DR 3 行
- 7 sections (`01` 全体俯瞰 / `02` SDK / exec / app-server の使い分け / `03` 標準装備のツール / `04` 認証モデル / `05` image_gen の経済性 / `06` JSON-RPC の往復 / `07` BYO サブスク配布)
- 6 figures (section 03 と 07 を除き各 section に 1 枚)
- 結論 3 行 + footer
- accent: `#10a37f` (ChatGPT green)

## 参考の中間 context

`/Users/masao/playground/codex-image-editor/explainer/context.md` (211 行)

- 過去会話のユーザー発言抜粋 (主要 5 問の出典)
- 主要 5 問への回答素材
- HTML 構成案 (1 カラム縦長)
- detail-illustration プロンプト草案

## 入力例 → slug の付け方

| 入力 (`$ARGUMENTS`) | slug | 想定 subagent |
|---|---|---|
| `Codex App Server とは` | `codex-app-server` | web research |
| `/Users/masao/playground/codex-image-editor` | `codex-image-editor` | delegate-explorer |
| `MCP vs Skill の違い` | `mcp-vs-skill` | web research |
| `Anthropic の computer use` | `anthropic-computer-use` | web research |
| `自分の repo の {/path/to/repo} を解説` | `<repo-name>` | delegate-explorer |

## アクセント色の選び方

トピックの主役プロダクトのブランドカラーを 1 色だけ拾う。複数ブランドが並ぶ比較記事 (`MCP vs Skill` / `OpenAI vs Anthropic`) の場合は中立色 (default の `#10a37f` か `#cc785c`) を選ぶ。

## figure の枚数判断ガイド

| section の中身 | figure を置く? |
|---|---|
| 概念図で構造を一発理解させたい (システム俯瞰 / シーケンス / 関係図) | はい |
| 比較表だけで自明 (3 列 × 5 行など) | いいえ (table のみ) |
| 経済性 / 数字が主役 | はい (天秤 / 折れ線のメタファー画像) |
| コード抜粋がメイン | いいえ (pre のみ) |
| リスク / 注意点の列挙 | いいえ (callout / risk table のみ) |
