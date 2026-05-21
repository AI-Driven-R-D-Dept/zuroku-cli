# @zuroku/cli

[![npm](https://img.shields.io/npm/v/@zuroku/cli.svg)](https://www.npmjs.com/package/@zuroku/cli)
[![skills.sh](https://skills.sh/b/AI-Driven-R-D-Dept/zuroku-cli)](https://skills.sh/AI-Driven-R-D-Dept/zuroku-cli)

Command-line publisher for [zuroku](https://github.com/MASAKASUNO1/zuroku) — uploads an HTML page plus its image assets to a zuroku instance and returns a shareable URL.

Designed for AI agents (Claude Code, etc.) and humans who generate static graphic-recording / explainer pages and want a one-shot deploy step.

## Install

```bash
npm install -g @zuroku/cli
# or
pnpm add -g @zuroku/cli
```

Requires Node.js 20+.

## Quick start

The CLI defaults to the AIDD-managed instance at `https://app.zuroku.masao.ai`. Pass `--base-url` to point at a self-hosted instance.

```bash
# 1. Get an API key from your zuroku app's Web UI → Settings → API keys,
#    then register it once (creates ~/.config/zuroku/config.json, mode 0600).
zuroku auth login --token zrk_live_xxx
# self-hosted instance:
# zuroku auth login --token zrk_live_xxx --base-url https://zuroku.example.com

# 2. Collect the HTML and its images into one directory and publish.
#    `images/<file>` references are auto-normalized to `img/<file>` for your
#    provided assets — no manual sed needed.
mkdir -p /tmp/zuroku-deploy
cp /path/to/index.html /path/to/images/*.png /tmp/zuroku-deploy/

cd /tmp/zuroku-deploy
zuroku publish ./index.html ./*.png --title "..."
# - assets are compressed to WebP client-side (sharp, 85% quality, max 2000px long-edge)
# - `images/foo.png` / `img/foo.png` are auto-rewritten to `img/foo.webp` (anchored to
#   your provided assets — external URLs that contain `images/` are left intact)
# - stdout last line is the public URL
```

> **Do not run a bare `sed 's|images/|img/|g'`.** It rewrites the substring
> `images/` everywhere, including external image URLs like
> `https://.../images/foo.webp`, turning them into broken `.../img/...` links (404).
> The CLI normalizes local references safely on its own. If you must hand-edit a
> different prefix (e.g. `assets/`), anchor to `src="assets/` so external URLs are untouched.

## Commands

| Command | Purpose |
|---|---|
| `zuroku auth login` | Save the API token to `~/.config/zuroku/config.json` (mode `0600`). |
| `zuroku publish <html> <assets...>` | Upload an HTML page and its referenced images. |
| `zuroku update <slug-or-id> <html> [images...]` | Republish an existing project, keeping its slug / URL (full asset replacement). |
| `zuroku list` | List the publishes owned by the current token. |
| `zuroku delete <slug>` | Soft-delete a publish. |
| `zuroku config (get\|set\|unset) <key>` | Read / write per-user CLI defaults (e.g. `default-visibility`). |

Run `zuroku <command> --help` for the full flag list.

### Update an existing publish

`zuroku update` republishes the same slug / URL (no `-2` suffix). The asset set is fully replaced — pass every image you want present after the update.

```bash
# slug or id (both work). HTML auto-rewrite & preflight are identical to publish.
zuroku update my-cool-page ./index.html ./img/*.png
```

Use this when you tweak the HTML or swap images but want the URL stable. To get a brand-new URL instead, `zuroku publish` again.

## HTML / asset constraints

- `<img src>` must use the `img/` relative prefix (e.g. `<img src="img/foo.png">`); served route is `/p/:slug/img/:filename`.
- Supported image types: PNG / JPEG / WebP / GIF. SVG is rejected.
- Default behaviour is to convert PNG/JPEG to WebP at 85% quality, max 2000px long-edge. The CLI auto-rewrites HTML `<img src>` from `.png` / `.jpg` to `.webp` to keep references valid (since v0.1.1).
- Pass `--no-compress` to keep the original PNG/JPEG bytes and filenames intact (skip WebP). Useful when source images are already optimised.
- HTML and each asset are capped at 5 MiB. Daily quota: 50 publishes / 500 MB per user.

The CLI parses the HTML and verifies that every `<img src="img/...">` resolves to a positional asset argument, fail-fast with tagged error messages:

| Tag | Meaning |
|---|---|
| `[MISSING]` | HTML references an image not in the asset list. |
| `[UNUSED]` | Asset passed in but not referenced from HTML. |
| `[WRONG-PATH]` | `<img src>` does not start with `img/`. |
| `LOCAL_PATH_LEAK` | HTML body contains an author-machine path (`/Users/…`, `/home/…`, `file://`, `C:\Users\…`, `/var/folders/…`). These 404 for viewers — strip them before publishing. Bypass with `ZUROKU_SKIP_PREFLIGHT=1` (debug only). |

## Visibility

Each publish has a visibility:

- `private` — only the owner can view.
- `curator` — viewable by Discord members with the configured curator role.
- `public` — viewable by anyone with the link (not just curators). Still kept out of the in-app timeline/search, and served with `X-Robots-Tag: noindex,nofollow` (link sharing / SNS unfurl only, no SEO indexing).

Order of precedence: CLI flag (`--private` > `--visibility`) → per-user config `default-visibility` → server default (`curator`).

```bash
# Per-user default
zuroku config set default-visibility private
zuroku config unset default-visibility   # back to server default
zuroku config get                        # show current settings
```

`public` can be set per publish (`zuroku publish … --visibility public`), but **cannot** be stored as a `default-visibility` config value — public exposure should always be a deliberate per-publish choice, never a silent default. You can also toggle visibility (including to/from `public`) later from the web UI.

## Output contract

`zuroku publish` writes the bare URL as the **last line of stdout**. Progress, info, and success messages go to stderr.

```bash
URL=$(zuroku publish ./index.html ./img/*.png --title "..." 2>/dev/null | tail -1)
```

## Claude Code skill

A ready-to-use Claude Code skill ships under [`skills/zuroku-publish/`](./skills/zuroku-publish/SKILL.md). It lets an AI agent drive `zuroku publish` end-to-end (HTML rewrite, asset check, fail-fast preflight) without further prompting.

Install it once via [`skills`](https://skills.sh):

```bash
# install all skills from this repo to the agents you choose
npx skills add AI-Driven-R-D-Dept/zuroku-cli

# or pick just this skill
npx skills add AI-Driven-R-D-Dept/zuroku-cli --skill zuroku-publish

# global (~/<agent>/skills/) install for Claude Code only
npx skills add AI-Driven-R-D-Dept/zuroku-cli -s zuroku-publish -a claude-code -g
```

Manual install also works: copy [`skills/zuroku-publish/SKILL.md`](./skills/zuroku-publish/SKILL.md) into your project's `.claude/skills/zuroku-publish/SKILL.md`.

## Claude Code plugin

This repo is also a [Claude Code plugin marketplace](https://docs.claude.com/en/docs/claude-code/plugins). Installing the plugin bundles both skills (`zuroku-publish`, `run-explainer-page`) under a `zuroku:` namespace.

```bash
# in Claude Code
/plugin marketplace add AI-Driven-R-D-Dept/zuroku-cli
/plugin install zuroku@zuroku
# → /zuroku:zuroku-publish, /zuroku:run-explainer-page become available
```

The plugin manifest lives in [`.claude-plugin/`](./.claude-plugin/) (`plugin.json` + `marketplace.json`).

> The plugin ships the skills only — it does **not** bundle the `zuroku` CLI. Install the CLI separately (`npm i -g @zuroku/cli`) so the skill's `zuroku …` calls resolve. If it's missing, the skill warns and points you to the install command.

## License

MIT — see [LICENSE](./LICENSE).
