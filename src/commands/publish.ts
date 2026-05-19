import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  compressForUpload,
  passthroughForUpload,
  ZurokuError,
  type AssetUpload,
} from '@zuroku/core';
import { fatal, info, success, warn } from '../lib/console.js';
import { loadRuntimeConfig, makeClient } from '../lib/config.js';
import { scanLocalPathLeaks, formatLeakReport } from '../lib/preflight.js';

const HTML_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * 圧縮で rename された asset (foo.png → foo.webp) に合わせて、HTML 内の
 * `<img src="img/foo.png">` 系の参照を `img/foo.webp` に置換する。
 *
 * - `img/` prefix を必須にすることで CSS/JS の同名 path を巻き込まない
 *   (zuroku の R2 layout 規約)。
 * - 部分一致 (`foo.png.bak`) を避けるため境界 lookahead を入れる:
 *   引用符 / 空白 / `)` / `,` のいずれかが直後に来る場合のみ rewrite。
 * - renameMap が空のときは byte 一致で素通し (--no-compress 等)。
 */
export function rewriteHtmlForRename(
  html: string,
  renameMap: ReadonlyArray<{ from: string; to: string }>,
): string {
  let out = html;
  for (const { from, to } of renameMap) {
    if (from === to) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(img/)${escaped}(?=["'\\s),])`, 'g'), `$1${to}`);
  }
  return out;
}

/**
 * HTML 内の `<img src="...">` / `<link href="...">` / `<script src="...">` /
 * `srcset` から、この project の asset として参照されている filename (basename) を
 * 抽出する。zuroku は `img/<basename>` を expected layout とするため、
 * `img/foo.png` 系を最優先で検出する。
 *
 * 戻り値: { references: 抽出した raw URL の配列、 expectedFilenames: img/ 直下の basename }
 */
export function extractHtmlAssetRefs(html: string): { references: string[]; expectedFilenames: Set<string> } {
  const references: string[] = [];
  const expectedFilenames = new Set<string>();
  const ATTR_RE = /(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(html)) !== null) {
    const url = m[1]!;
    // 外部 URL / data URI / fragment はスキップ
    if (/^(https?:|data:|mailto:|#)/i.test(url)) continue;
    references.push(url);
    // zuroku の R2 layout: img/<filename>
    const imgMatch = url.match(/^(?:\.\/)?img\/([^/?#]+)/);
    if (imgMatch) expectedFilenames.add(imgMatch[1]!);
  }
  // srcset (`a.png 1x, b.png 2x`) も簡易対応
  const SRCSET_RE = /srcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = SRCSET_RE.exec(html)) !== null) {
    for (const part of m[1]!.split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (!url || /^(https?:|data:)/i.test(url)) continue;
      references.push(url);
      const imgMatch = url.match(/^(?:\.\/)?img\/([^/?#]+)/);
      if (imgMatch) expectedFilenames.add(imgMatch[1]!);
    }
  }
  return { references, expectedFilenames };
}

/**
 * AI agent 向けの詳細エラーメッセージを生成。
 * preflight で HTML と提供 asset の不整合を検知したとき呼ぶ。
 */
export function preflightErrorMessage(
  htmlPath: string,
  htmlRefs: string[],
  htmlExpected: Set<string>,
  providedAssetFilenames: string[],
  compress: boolean,
): string {
  const provided = new Set(providedAssetFilenames);
  const missingFromAssets = [...htmlExpected].filter((f) => !provided.has(f));
  const extraAssets = providedAssetFilenames.filter((f) => !htmlExpected.has(f));

  // 非 img/ 参照 (zuroku が期待する layout と違うもの)
  const nonImgRefs = htmlRefs.filter(
    (r) => !/^(?:\.\/)?img\//.test(r) && !/^\/?(style|css|js)/i.test(r),
  );

  const lines: string[] = [];
  lines.push('Preflight check failed: HTML asset references do not match provided files.');
  lines.push('');
  lines.push(`HTML file: ${htmlPath}`);
  lines.push(`Compress mode: ${compress ? 'ON (sharp WebP; HTML img src extensions are rewritten automatically)' : 'OFF (--no-compress)'}`);
  lines.push('');
  lines.push('zuroku layout requirement:');
  lines.push('  - HTML must reference assets as `img/<filename>` (relative to HTML location)');
  lines.push('  - Each <filename> must match one of the provided asset arguments (basename)');
  lines.push('  - The CLI auto-rewrites `img/foo.png` -> `img/foo.webp` when compress is ON;');
  lines.push('    you only need to pre-align extensions when --no-compress is set.');
  lines.push('');

  if (missingFromAssets.length) {
    lines.push('[MISSING] HTML refers to these img/ files but they were not provided as assets:');
    for (const f of missingFromAssets) lines.push(`  - img/${f}`);
    lines.push('');
  }

  if (extraAssets.length) {
    lines.push('[UNUSED] These asset files were passed but not referenced from HTML <img src="img/...">:');
    for (const f of extraAssets) lines.push(`  - ${f}`);
    lines.push('');
  }

  if (nonImgRefs.length) {
    lines.push('[WRONG-PATH] HTML refers to these relative URLs that do not start with `img/`:');
    for (const r of nonImgRefs.slice(0, 8)) lines.push(`  - ${r}`);
    if (nonImgRefs.length > 8) lines.push(`  ... (${nonImgRefs.length - 8} more)`);
    lines.push('  Fix: rewrite to `img/<basename>` (e.g. `images/foo.png` -> `img/foo.png`).');
    lines.push('       sed example: sed -i \'\' \'s|images/|img/|g\' your.html');
    lines.push('');
  }

  lines.push('Suggested fixes (for AI agents to choose):');
  lines.push('  A) Ensure each <img src="img/foo.ext"> has a matching asset argument (foo.ext).');
  lines.push('  B) If file extensions differ (e.g. HTML says foo.png but asset is foo.jpg),');
  lines.push('     rename the asset or update the HTML to match.');
  lines.push('  C) Use --no-compress if you must keep original PNG/JPEG filenames (skips WebP).');
  lines.push('');
  lines.push('To bypass this check (NOT recommended), set ZUROKU_SKIP_PREFLIGHT=1.');
  return lines.join('\n');
}

interface PublishOpts {
  title: string;
  slug?: string;
  description?: string;
  compress: boolean; // commander negates --no-compress -> compress: false
  baseUrl?: string;
  visibility?: string;
  private?: boolean;
}

export function registerPublishCommand(parent: Command): void {
  parent
    .command('publish')
    .description('Upload an HTML file (and optional images) and publish a project')
    .argument('<html>', 'Path to the HTML file (<= 5 MiB)')
    .argument('[images...]', 'Image files to upload as assets')
    .requiredOption('-T, --title <title>', 'Project title')
    .option('-s, --slug <slug>', 'Custom slug (default: server-generated)')
    .option('-d, --description <text>', 'Project description')
    .option('--no-compress', 'Skip image compression (upload originals)')
    .option('-u, --base-url <url>', 'Override API base URL')
    .option(
      '-V, --visibility <mode>',
      "Visibility: private | curator. Server reserves 'public' and rejects it. Falls back to --private then ~/.config/zuroku/config.json then server default (curator) when omitted.",
    )
    .option('--private', 'Shortcut for --visibility private (wins over --visibility if both are set)')
    .action(async (htmlArg: string, images: string[], opts: PublishOpts) => {
      try {
        const config = await loadRuntimeConfig({ ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });

        // ---- HTML ---------------------------------------------------------
        const htmlPath = path.resolve(htmlArg);
        let htmlStat;
        try {
          htmlStat = await fs.stat(htmlPath);
        } catch {
          throw new ZurokuError('NOT_FOUND', 0, `HTML file not found: ${htmlArg}`);
        }
        if (!htmlStat.isFile()) {
          throw new ZurokuError('INVALID_INPUT', 0, `Not a regular file: ${htmlArg}`);
        }
        if (htmlStat.size > HTML_MAX_BYTES) {
          throw new ZurokuError(
            'PAYLOAD_TOO_LARGE',
            413,
            `HTML file exceeds 5 MiB limit (${htmlStat.size} bytes)`,
          );
        }
        const htmlBuf = await fs.readFile(htmlPath);
        info(`html: ${path.basename(htmlPath)} (${htmlStat.size} bytes)`);

        // ---- Assets -------------------------------------------------------
        // 圧縮時 (default) は .png/.jpg/.jpeg の filename が .webp に rename される。
        // HTML 側の <img src="img/foo.png"> をそのままにすると preflight が
        // [MISSING] で fail するので、rename map を取って後段で HTML を自動 rewrite する。
        const assets: AssetUpload[] = [];
        const renameMap: Array<{ from: string; to: string }> = [];
        for (const img of images) {
          const abs = path.resolve(img);
          const label = path.basename(abs);
          const payload = opts.compress
            ? await compressForUpload(abs)
            : await passthroughForUpload(abs);
          info(
            `asset: ${label} -> ${payload.filename} (${payload.buffer.byteLength} bytes, ${payload.contentType})`,
          );
          if (label !== payload.filename) {
            renameMap.push({ from: label, to: payload.filename });
          }
          assets.push({
            filename: payload.filename,
            buffer: payload.buffer,
            contentType: payload.contentType,
          });
        }

        // ---- HTML auto-rewrite for compressed assets ----------------------
        // --no-compress 時は renameMap が空なので no-op (byte 一致)。
        const htmlOriginal = htmlBuf.toString('utf8');
        const htmlText = renameMap.length > 0 ? rewriteHtmlForRename(htmlOriginal, renameMap) : htmlOriginal;
        if (renameMap.length > 0 && htmlText !== htmlOriginal) {
          info(`html: rewrote <img src> references for ${renameMap.length} compressed asset(s)`);
        }
        const htmlForUpload = htmlText !== htmlOriginal ? Buffer.from(htmlText, 'utf8') : htmlBuf;

        // ---- Preflight: local-path leak scan (asset 参照外も含む全文) -----
        if (process.env.ZUROKU_SKIP_PREFLIGHT !== '1') {
          const leaks = scanLocalPathLeaks(htmlText);
          for (const w of leaks.filter((l) => l.severity === 'warn')) {
            warn(`local-path hint at line ${w.line} [${w.pattern}]: ${w.match}`);
          }
          const errors = leaks.filter((l) => l.severity === 'error');
          if (errors.length > 0) {
            throw new ZurokuError('LOCAL_PATH_LEAK', 0, formatLeakReport(htmlPath, errors));
          }
        }

        // ---- Preflight: HTML asset refs vs provided assets ----------------
        if (process.env.ZUROKU_SKIP_PREFLIGHT !== '1') {
          const { references, expectedFilenames } = extractHtmlAssetRefs(htmlText);
          const providedFilenames = assets.map((a) => a.filename);
          const provided = new Set(providedFilenames);
          const missing = [...expectedFilenames].filter((f) => !provided.has(f));
          const nonImg = references.filter(
            (r) => !/^(?:\.\/)?img\//.test(r) && !/^\/?(style|css|js|favicon)/i.test(r) && !/^[a-z]+:/i.test(r),
          );
          // 致命的とみなすケース: img/ 参照 (= zuroku layout) があるのに asset と一致しない
          // または HTML に img タグがあるが img/ prefix を一切使っていない (path mismatch)
          const hasImgTag = /<img\b[^>]*src=/i.test(htmlText);
          const layoutBroken = hasImgTag && expectedFilenames.size === 0 && nonImg.length > 0;
          if (missing.length > 0 || layoutBroken) {
            throw new ZurokuError(
              'INVALID_INPUT',
              0,
              preflightErrorMessage(htmlPath, references, expectedFilenames, providedFilenames, opts.compress),
            );
          }
        }

        // ---- Visibility preflight -----------------------------------------
        // -V/--visibility と --private は両立可。--private が指定されたら 'private' に強制。
        // どちらの flag も無いときは config.default_visibility を fallback として採用する
        // (`zuroku config set default-visibility ...` で設定)。
        let visibility: 'private' | 'curator' | 'public' | undefined;
        if (opts.visibility !== undefined) {
          if (
            opts.visibility !== 'private' &&
            opts.visibility !== 'curator' &&
            opts.visibility !== 'public'
          ) {
            throw new ZurokuError(
              'INVALID_INPUT',
              0,
              `--visibility must be 'private' | 'curator' | 'public' (got '${opts.visibility}')`,
            );
          }
          visibility = opts.visibility;
        }
        if (opts.private) {
          // 両方指定された場合は --private が勝つ。silent override は事故の元なので warn 級で
          // ユーザに明示 (info の海に埋もれないように)。
          if (visibility !== undefined && visibility !== 'private') {
            warn(`--private overrides --visibility ${visibility}`);
          }
          visibility = 'private';
        }
        if (visibility === undefined && config.default_visibility !== undefined) {
          visibility = config.default_visibility;
          info(`visibility: ${visibility} (from config default_visibility)`);
        }

        // ---- Publish ------------------------------------------------------
        const client = makeClient(config);
        const visLabel = visibility ? ` (visibility=${visibility})` : '';
        info(`publishing as "${opts.title}"${opts.slug ? ` (slug=${opts.slug})` : ''}${visLabel}...`);

        const input: Parameters<typeof client.publishProject>[0] = {
          html: htmlForUpload,
          assets,
          title: opts.title,
        };
        if (opts.slug !== undefined) input.slug = opts.slug;
        if (opts.description !== undefined) input.description = opts.description;
        if (visibility !== undefined) input.visibility = visibility;

        const res = await client.publishProject(input);

        success(`published: slug=${res.slug} id=${res.id}`);
        if (visibility === 'private') {
          info('(private — only you can view this project until you change visibility)');
          // app base URL は config.base_url。app.* → settings/projects はそのまま app の方。
          const appBase = config.base_url.replace(/\/+$/, '');
          info(`manage visibility: ${appBase}/settings/projects`);
        }
        // Final stdout line: bare URL so tools (Claude Code etc.) can grab it.
        process.stdout.write(`${res.url}\n`);
      } catch (e) {
        fatal(e);
      }
    });
}
