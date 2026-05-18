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

# 2. Make sure your HTML references images as `<img src="img/foo.png">`.
#    If your generator emits `images/...`, rewrite it first:
mkdir -p /tmp/zuroku-deploy
sed 's|images/|img/|g' /path/to/index.html > /tmp/zuroku-deploy/index.html
cp /path/to/images/*.png /tmp/zuroku-deploy/

cd /tmp/zuroku-deploy
zuroku publish ./index.html ./*.png --title "..." --no-compress
# stdout last line is the public URL.
```

## Commands

| Command | Purpose |
|---|---|
| `zuroku auth login` | Save the API token to `~/.config/zuroku/config.json` (mode `0600`). |
| `zuroku publish <html> <assets...>` | Upload an HTML page and its referenced images. |
| `zuroku list` | List the publishes owned by the current token. |
| `zuroku delete <slug>` | Soft-delete a publish. |
| `zuroku config (get\|set\|unset) <key>` | Read / write per-user CLI defaults (e.g. `default-visibility`). |

Run `zuroku <command> --help` for the full flag list.

## HTML / asset constraints

- `<img src>` must use the `img/` relative prefix (e.g. `<img src="img/foo.png">`); served route is `/p/:slug/img/:filename`.
- Supported image types: PNG / JPEG / WebP / GIF. SVG is rejected.
- Default behaviour is to convert PNG/JPEG to WebP at 85% quality, max 2000px long-edge. Pass `--no-compress` to keep filenames and bytes intact (you must then resize manually).
- HTML and each asset are capped at 5 MiB. Daily quota: 50 publishes / 500 MB per user.

The CLI parses the HTML and verifies that every `<img src="img/...">` resolves to a positional asset argument, fail-fast with tagged error messages:

| Tag | Meaning |
|---|---|
| `[MISSING]` | HTML references an image not in the asset list. |
| `[UNUSED]` | Asset passed in but not referenced from HTML. |
| `[WRONG-PATH]` | `<img src>` does not start with `img/`. |

## Visibility

Each publish has a visibility:

- `private` — only the owner can view.
- `curator` — viewable by Discord members with the configured curator role.

Order of precedence: CLI flag (`--private` > `--visibility`) → per-user config `default-visibility` → server default (`curator`).

```bash
# Per-user default
zuroku config set default-visibility private
zuroku config unset default-visibility   # back to server default
zuroku config get                        # show current settings
```

`public` is reserved by the server and rejected by both CLI and API. To make something publicly visible, publish as `curator` and toggle visibility from the web UI.

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

## License

MIT — see [LICENSE](./LICENSE).
