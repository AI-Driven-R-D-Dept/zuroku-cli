---
name: run-explainer-page
template: domain
description: 入力 context から図解付きの 1 枚 HTML 解説ページを作りたい場面で発動。「解説ページ作って」「explainer page」で発動。
user-invocable: true
argument-hint: "[topic | URL | file path]"
---

# run-explainer-page

ユーザー入力 (topic 文字列 / URL / ファイルパス / 直前会話) を起点に、
**1 枚 HTML の図解付き解説ページ** を生成する orchestrator。

## Input / Output

- **Input**: `$ARGUMENTS` = topic 文字列 / URL / ローカルファイルパス のいずれか。**空なら直前会話を context として拾う**
- **Output**: `output/explainer-{slug}/index.html` (CSS インライン 1 ファイル + `images/concept-NN-01.png` 群)
- **副産物**: `output/explainer-{slug}/{context.md, outline.json}` (再生成用)

## 最重要 (compaction 切り捨て対策)

- **1 ターンで Phase 1-5 全部走る** (フェーズ間で応答終了しない、SubagentStop hook が二重発火する)
- **画像は engine 直叩き + STYLE 行固定** (`wrap-ai-image-detail-illustration` を Skill 経由で呼ぶと 4 並列メタファー振りで意図とずれる。`run-ai-images/scripts/generate.sh -n 1` を直接呼び、再走時も S1 STYLE 行は変えない)
- **1 枚 HTML 縛り** (CDN を引かない、`<style>` インライン + system font stack で完結)
- **fork 配下なら Agent ツール不可** (`run-pipe-line` / `run-eval-loop-fork` 等から呼ばれた場合は Phase 1 を `delegate-explorer` 1 本に縮退、§Phase 1 末尾参照)

詳細・他の落とし穴は **Gotchas** に集約。

## いつ使う / 使わない

| 用途 | 使うスキル |
|---|---|
| **figure 付き 1 枚 HTML 解説ページ** | **`run-explainer-page`** ← この skill |
| SEO ブログ記事 (Markdown) | `run-seo-blog` |
| スライド (PDF) | `run-slide` |
| 説明画像 4 並列 (HTML 化なし) | `wrap-ai-image-detail-illustration` |
| 任意プロンプト画像 1 枚 | `run-ai-images` |

## Phase 1: Research (subagent fan-out)

入力をパースして以下のいずれか or 両方の subagent を起動する。**親で要約だけ受け取る** (探索結果を主コンテキストに吸わせない)。

### 判定ルール

- 入力に **ローカルパス / リポジトリ名 / コードベース題材** を含む → `delegate-explorer`
- 入力が **抽象トピック / 一般技術ネタ** → 内蔵 web research subagent (Agent ツール `subagent_type: general-purpose`)
- 両方ありうるなら **並列 fire** (1 メッセージで Agent + Skill を同時に呼ぶ)

### fork 縮退モード (最重要 §4 の詳細)

parent が fork context (`run-pipe-line` / `run-eval-loop-fork` 等の配下) で呼ばれると Agent ツールが使えない。その場合は **`delegate-explorer` 1 本に縮退** する:

- ローカル context あり → `delegate-explorer` で従来どおり読み込み
- 抽象トピックのみ → `delegate-explorer` を **WebSearch / WebFetch hint 付き** で起動 (delegate-explorer は両ツールを持つ)。query に「公式ドキュメントを WebFetch で読んで〜」と明示する

### delegate-explorer の呼び方

```
Skill({
  skill: "delegate-explorer",
  args: "<検索クエリ。題材コードベースで何を読んで context.md にするか具体的に。\
         例: 'codex-image-editor の Tauri spawn 部分 (src-tauri/src/codex/process.rs) と \
         image watcher (src-tauri/src/images/watcher.rs) を読んで、JSON-RPC 通信と \
         image_gen の経済性に関わる実装抜粋を 300 語以内で'>"
})
```

### Web research subagent prompt (Agent ツール)

```
Agent({
  description: "explainer-page Phase 1 web research",
  subagent_type: "general-purpose",
  prompt: "<下記の指示文をそのまま渡す>"
})
```

指示文テンプレ:

```
あなたは 1 枚 HTML 解説ページの context 作成役。トピック: 「<TOPIC>」

以下を 500 語以内のサマリで返す:

1. トピックの 1 行定義 (権威ある定義に揃える、必要なら WebSearch / WebFetch で公式ドキュメント取得)
2. TL;DR 3 行 (各 1 文)
3. 主要 5-7 問 (= 解説で答えるべき問い)。良い問いの例: 「なぜ X ではなく Y なのか」「X の正体は何か」「X を使う条件は何か」
4. 各問いへの簡潔な回答素材 (確証ある事実のみ。仮説には [仮説] と明記)
5. 結論 3 行
6. 図解候補 3-8 個 (各 figure ごとにメタファー / レイアウト案 1 行)
7. 数字 (価格 / 性能 / リリース日 等) は 必ず出典 URL と取得日を併記する

主要 5-7 問は必ず捻り出す。トピックが抽象的でも仮説で踏み込んで構わない。
出力は親が context.md に流し込むのでマークダウン書式で返す。
```

### context.md 構成 (親が subagent サマリを統合して Write)

`output/explainer-{slug}/context.md` に以下を書く。slug はトピックから kebab-case (例: `codex-app-server` / `mcp-vs-skill` / `byo-llm-distribution`):

```markdown
# {topic} — context

## 1 行定義
...

## TL;DR
1. ...
2. ...
3. ...

## 主要 5-7 問
1. **<問い>**
   - <回答素材>
2. ...

## 結論
1. ...
2. ...
3. ...

## 図解候補
- figure-01: <概念> / メタファー: <...> / レイアウト: <...>
- figure-02: ...
```

## Phase 2: Outline 設計 (orchestrator が直接)

context.md を読んで HTML 構成を JSON で確定する。**figure を置くか否かは Claude が判断** (情報量があり概念図にして伝わるなら置く / 表だけで自明なら省略)。最終 figure 数は 3-8 のレンジ。

`output/explainer-{slug}/outline.json` に Write:

```json
{
  "slug": "codex-app-server",
  "accent": "#10a37f",
  "hero": {
    "kicker": "CODEX APP SERVER 解説",
    "h1": "Codex App Server とは — 自分の ChatGPT サブスクで動く AI アプリの裏側",
    "lede": "<2-3 文の lede>",
    "tldr": ["...", "...", "..."]
  },
  "sections": [
    {
      "num": "01",
      "title": "全体俯瞰 — 何が「裏で」起きているか",
      "sub": "<sub 1 行>",
      "figure": {
        "concept": "<図で何を伝えるか 1 行>",
        "metaphor": "<具体的なメタファー (例: ハブ駅 / 執事 / ハイテクキッチン)>",
        "layout": "<配置の指示 (例: 中央ブロック + 左右に矢印)>",
        "alt": "<img alt>",
        "caption": "<figcaption>"
      },
      "blocks": [
        { "type": "p", "text": "..." },
        { "type": "callout", "text": "<本文>" },
        { "type": "table", "headers": ["...","..."], "rows": [["...","..."]], "pick_row": 0 },
        { "type": "pre", "lang": "rust", "code": "..." },
        { "type": "callout-warn", "text": "..." },
        { "type": "list", "items": ["...", "..."] },
        { "type": "quote", "text": "..." }
      ]
    }
  ],
  "conclusion": ["...", "...", "..."],
  "footer": "題材: <path or URL>"
}
```

`figure: null` で figure なし section も許容するが、その場合は table / callout / pre のいずれかで視覚的メリハリを必ず出す (ベタテキスト section は退屈)。

## Phase 3: 画像 fan-out

outline の **figure を持つ section** に対して、`run-ai-images/scripts/generate.sh` を `-n 1` で並列 fire。

### プロンプト本文 (`wrap-ai-image-detail-illustration` SKILL.md の組み立て本文を流用)

S1 (グラレコ手描きマーカー) を STYLE 固定。aspect は 16:9。

```
説明画像、16:9、グラレコ風手描きマーカータッチ、温かみのある配色、和紙のような背景、手書き線画。

【テーマ】<section.title から派生>

【構成/レイアウト】<section.figure.layout>

【メタファー】<section.figure.metaphor>

【必須要素】
- タイトル(日本語、大きめ)
- サブタイトル or キャッチコピー(日本語)
- 各要素にアイコン・絵文字を添える(👍 👎 ✅ ⚠️ 💡 ⚙️ 🚀 📚 等)
- メリット/デメリット/ポイントは箇条書きで 3 点ずつ

【スタイル】
- 手描き風、温かみ、情報量多め
- 日本語ラベル・テキストを読みやすいサイズで
- 視線誘導(矢印・天秤・番号など)

【禁止】抽象的な幾何模様だけで終わらせない、英語ラベルにしない、情報スカスカにしない
```

### 並列 fire パターン (Bash バックグラウンド)

prefix は `concept-{NN}` (NN = section.num)。1 メッセージで全 figure を background 起動 → `wait` で揃え:

```bash
mkdir -p output/explainer-{slug}/images
( bash .claude/skills/run-ai-images/scripts/generate.sh \
    -o output/explainer-{slug}/images/concept-01 --aspect 16:9 -n 1 \
    -p "<section 01 のプロンプト本文>" > /tmp/explainer-01.log 2>&1 ) &
( bash .claude/skills/run-ai-images/scripts/generate.sh \
    -o output/explainer-{slug}/images/concept-02 --aspect 16:9 -n 1 \
    -p "<section 02 のプロンプト本文>" > /tmp/explainer-02.log 2>&1 ) &
# ... 必要数まで
wait
```

各 worker の出力は `concept-NN-01.png` (engine の suffix 付与は -n 1 でも変わらない)。HTML から `images/concept-NN-01.png` で参照する。

### 部分リトライ

不合格があれば、その NN だけ同じ prefix で再 fire (上書きされる)。プロンプト本文の S1 STYLE 行は **再走時も変えない** (スタイル一貫性)。

## Phase 4: HTML 組み立て

`templates/skeleton.html` を Read してスタイル・基本構造を把握し、outline.json に従って `output/explainer-{slug}/index.html` を Write する。

### ブロック → HTML 対応

| outline block.type | HTML |
|---|---|
| `p` | `<p>{text}</p>` |
| `list` | `<ul><li>...</li></ul>` |
| `table` | `<table class="table"><thead><tr><th>...</th></tr></thead><tbody><tr class="pick">...</tr></tbody></table>` (`pick_row` で推し行) |
| `pre` | `<pre>` + 簡易ハイライト span (`c`=コメント / `k`=キーワード / `s`=文字列 / `n`=識別子)。lang は読み手向けの参考扱い |
| `callout` | `<div class="callout"><p>{text}</p></div>` |
| `callout-warn` | `<div class="callout warn"><p>{text}</p></div>` |
| `quote` | `<div class="quote">{text}</div>` |

### figure ブロック

```html
<figure>
  <img src="images/concept-NN-01.png" alt="{alt}">
  <figcaption>{caption}</figcaption>
</figure>
```

`NN` は `section.num` と完全一致させる。

### アクセント色の決め方

`outline.accent` で決め打ち。トピックに応じて Claude が選んでよい:

| トピック傾向 | accent 候補 |
|---|---|
| ChatGPT / OpenAI 系 | `#10a37f` (ChatGPT green) |
| Anthropic 系 | `#cc785c` (Anthropic 橙) |
| AWS 系 | `#ff9900` |
| 汎用 / 迷ったら | `#10a37f` (参考 explainer の default) |

**置換手順**: Read で `templates/skeleton.html` を読み込み、`:root { --accent: #10a37f;` の `#10a37f` を `outline.accent` の値に文字列置換 (`--accent-soft` も同系の薄色に揃える、例: `#10a37f` → `#d6f0e6` / `#cc785c` → `#f5e0d6`)。置換後の本文に各 section / hero / conclusion を流し込んで `output/explainer-{slug}/index.html` に Write。`templates/skeleton.html` 自体は **書き換えない** (テンプレ汚染防止)。

## Phase 5: open

```bash
open output/explainer-{slug}/index.html
```

ブラウザで目視確認。日本語ラベルが化けていない / figure が情報スカスカではない / アクセント色が崩れていない を見る。

## Gotchas

- **入力が薄い (1 行 topic) と context.md がスカスカ** → Phase 1 subagent prompt に「主要 5-7 問は必ず捻り出す / 結論まで仮説で踏み込む」を埋め込んでいるのは、これを外すと HTML が文字数だけ稼いで中身ゼロになるため。指示文から外さない
- **section.num と画像 prefix のずれ** → outline.json `"num": "01"` ↔ 画像 `concept-01-01.png` を 1:1 で紐付ける。ゼロパディング (01 / 02 / ... / 09 / 10) を統一すると img src 生成バグが減る (HTML 側 `images/concept-NN-01.png` の NN を文字列連結で組むため)
- **アクセント色は 1 色** → CSS 変数 `--accent` を 1 色だけ振る。複数アクセント (緑 + 橙を併用等) は情報設計の階層を壊す
- **figure なし section をベタ `<p>` だけにしない** → table / callout / pre のいずれかを必ず置く (退屈さは離脱を生む)
- **再生成時に context.md / outline.json を勝手に消さない** → 同じ slug で再走したら既存ファイルの diff を提示。ユーザーが「再生成して」と言わない限り上書きしない
- **数字には出典** → Phase 1 で取得した価格 / 性能数字は出典 URL を outline に入れて `<p style="font-size: 13px; color: var(--ink-2);">※ 出典: ...</p>` で section 末尾に置く。出典なしの数字を断定形で書かない

## Additional resources

- `templates/skeleton.html` — CSS トークン (`--ink` / `--bg` / `--paper` / `--line` / `--accent` / `--accent-soft` / `--warn` / `--warn-soft` / `--yellow` / `--shadow` / `--mono` / `--sans`) と body 骨格 (`.wrap` > `header.hero` > `section[]` > `.conclusion` > `footer`) を持つ最小スケルトン
- `examples.md` — 参考の最終成果物 (`/Users/masao/playground/codex-image-editor/explainer/index.html`) と context.md の引用
- 画像 engine: `.claude/skills/run-ai-images/scripts/generate.sh` (引数仕様はそちらの先頭コメント参照)
- メタプロンプト本文の本家: `.claude/skills/wrap-ai-image-detail-illustration/SKILL.md` の「組み立て本文」節
