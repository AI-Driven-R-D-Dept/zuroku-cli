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
import { ensureNoReferrerForExternal } from '../lib/referrer-policy.js';

const HTML_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * HTML 内の asset 参照を zuroku の layout 規約 (`img/<final-filename>`) に正規化する。
 *
 * 対応する 2 種類の差分:
 *   1. ディレクトリ名揺れ: `images/foo.png` (skill 出力に多い複数形) → `img/foo.png`
 *   2. 拡張子 rename: 圧縮で `foo.png` → `foo.webp` になったケース
 *
 * - 単数 `img/` と複数 `images/` のみマッチさせる。`assets/` `style/` `js/` は触らない
 *   (CSS/JS path 保護)。
 * - 部分一致 (`foo.png.bak`) を避けるため境界 lookahead を入れる:
 *   引用符 / 空白 / `)` / `,` のいずれかが直後に来る場合のみ rewrite。
 * - renameMap・providedFilenames が両方空のときは byte 一致で素通し。
 *
 * @param renameMap         拡張子変換 (`{from: 'foo.png', to: 'foo.webp'}`) のリスト
 * @param providedFilenames upload する最終 filename 一覧。`images/<name>` → `img/<name>` の
 *                          path 正規化を駆動するため、rename が無い asset でも entry が必要。
 *                          省略時は renameMap のみで動作 (拡張子変換だけ)。
 */
export function rewriteHtmlForRename(
  html: string,
  renameMap: ReadonlyArray<{ from: string; to: string }>,
  providedFilenames: ReadonlyArray<string> = [],
): string {
  // 統合 mapping: HTML に出現しうる basename → server に upload する最終 filename
  // - provided は identity (path 正規化用)
  // - renameMap が後勝ちで上書き (拡張子変換)
  const map = new Map<string, string>();
  for (const f of providedFilenames) map.set(f, f);
  for (const { from, to } of renameMap) map.set(from, to);

  let out = html;
  for (const [from, to] of map) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 境界 lookahead: 引用符 / 空白 / ) , の他に `>` も許す。`<img src=img/foo.png>` の
    // ような unquoted 属性で src が `>` 直前に来るケースを取りこぼすと、compress の
    // .png→.webp rename が効かず本番ページが .png 404 になる。`.bak` 等の部分一致は
    // 直後が `.` なので引き続き弾かれる。
    out = out.replace(
      new RegExp(`(?:img|images)/${escaped}(?=["'\\s),>])`, 'g'),
      `img/${to}`,
    );
  }
  return out;
}

/**
 * `--keep-assets` 専用: サーバに既存の asset filename に合わせて HTML のローカル画像
 * 参照を rewrite する。
 *
 * keep-assets では新規 asset を送らない (provided が空) ため rewriteHtmlForRename の
 * 拡張子/path 正規化が効かず、ソース HTML の `images/foo.png` 等がサーバの
 * `img/foo.webp` を指さず全画像 404 になる事故があった。サーバの filename を取得し、
 * exact filename → stem (拡張子除去) 一致の順で `(?:img|images)/<file>` を
 * `img/<serverfile>` に揃える。
 *
 * 安全策 (bare sed / 外部 URL 破壊の二の舞を避ける):
 *  - **属性値スコープ**で処理する。`src` / `href` / `poster` / `srcset` の値だけを見て、
 *    値が**絶対 URL (`scheme:` / `//` 始まり) / `data:` / fragment なら一切触らない**。
 *    これにより外部 URL のクエリや括弧内に `images/foo.png` があっても壊さない
 *    (旧実装は HTML 全文 regex + lookbehind で `?x=images/..` 等を誤爆し得た)。
 *  - server に exact も unique stem も無い参照は rewrite せず unmatched (呼び出し側で warn)。
 *  - stem が複数 server file に衝突する場合は曖昧として rewrite しない (unmatched)。
 *
 * 戻り値: { html, rewritten: 置換した元参照, unmatched: server に無く未解決の参照 }
 */
export function rewriteHtmlToServerAssets(
  html: string,
  serverFilenames: ReadonlyArray<string>,
): { html: string; rewritten: string[]; unmatched: string[] } {
  const exact = new Set(serverFilenames);
  const stemMap = new Map<string, string>();
  const ambiguousStems = new Set<string>();
  for (const f of serverFilenames) {
    const stem = f.replace(/\.[^.]+$/, '');
    if (stemMap.has(stem) && stemMap.get(stem) !== f) ambiguousStems.add(stem);
    else stemMap.set(stem, f);
  }

  const rewritten = new Set<string>();
  const unmatched = new Set<string>();
  // 値が `(?:./)?(img|images)/<file>[?#...]` のローカル画像参照か判定し、server asset に解決。
  const LOCAL_REF = /^(?:\.\/)?(?:img|images)\/([A-Za-z0-9._@()\-]+\.[A-Za-z0-9]+)([?#][^\s]*)?$/;
  const resolveRef = (raw: string): string => {
    const v = raw.trim();
    // 絶対 URL / protocol-relative / data: / fragment は対象外 (外部 URL を壊さない)
    if (/^(?:[a-z][a-z0-9+.\-]*:|\/\/|#|data:)/i.test(v)) return raw;
    const m = v.match(LOCAL_REF);
    if (!m) return raw;
    const fname = m[1]!;
    const suffix = m[2] ?? '';
    let target: string | undefined;
    if (exact.has(fname)) {
      target = fname;
    } else {
      const stem = fname.replace(/\.[^.]+$/, '');
      if (!ambiguousStems.has(stem)) target = stemMap.get(stem);
    }
    if (!target) {
      unmatched.add(v);
      return raw;
    }
    const next = `img/${target}${suffix}`;
    if (next !== v) rewritten.add(v);
    return next;
  };

  let out = html;
  // 引用付き src/href/poster
  out = out.replace(
    /\b(src|href|poster)(\s*=\s*)(["'])([^"']*)\3/gi,
    (_m, attr: string, eq: string, q: string, val: string) => `${attr}${eq}${q}${resolveRef(val)}${q}`,
  );
  // 引用なし src/href/poster (空白 / > まで)
  out = out.replace(
    /\b(src|href|poster)(\s*=\s*)([^"'\s>]+)/gi,
    (_m, attr: string, eq: string, val: string) => `${attr}${eq}${resolveRef(val)}`,
  );
  // srcset (カンマ区切り候補: `url [descriptor]`。スペース無しカンマも分割する)
  out = out.replace(
    /\bsrcset(\s*=\s*)(["'])([^"']*)\2/gi,
    (_m, eq: string, q: string, val: string) => {
      const cands = val
        .split(',')
        .map((c) => {
          const seg = c.trim();
          if (!seg) return '';
          const sp = seg.split(/\s+/);
          sp[0] = resolveRef(sp[0]!);
          return sp.join(' ');
        })
        .filter((c) => c.length > 0);
      return `srcset${eq}${q}${cands.join(', ')}${q}`;
    },
  );
  return { html: out, rewritten: [...rewritten], unmatched: [...unmatched] };
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
      "Visibility: private | curator | public. 'public' is viewable by anyone with the link (kept out of timeline/search, served noindex); it can be set per publish but not stored as a config default. Falls back to --private then ~/.config/zuroku/config.json then server default (curator) when omitted.",
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

        // ---- HTML auto-rewrite (path 正規化 + 拡張子 rename) -----------------
        // providedFilenames を渡すことで `images/foo.png` → `img/foo.webp` (or .png)
        // の path 正規化も走る (--no-compress でも有効)。
        const htmlOriginal = htmlBuf.toString('utf8');
        const providedFilenames = assets.map((a) => a.filename);
        let htmlText = rewriteHtmlForRename(htmlOriginal, renameMap, providedFilenames);
        if (htmlText !== htmlOriginal) {
          info(`html: rewrote img src references (path normalize / extension rename)`);
        }

        // ---- HTML auto-rewrite (hotlink protection: 外部 subresource に referrerpolicy) -----
        // 配信ドメインを Referer に載せると X / 一部 CDN / 報道サイトが hotlink protection で
        // 403 を返す (curl では 200 が返るのでローカル検証では気付けない)。
        // <img src="https://..."> / <iframe src="https://..."> に referrerpolicy="no-referrer"
        // を自動付与し、agent が忘れても publish ページが描画破綻しないようにする。
        const rp = ensureNoReferrerForExternal(htmlText);
        htmlText = rp.html;
        if (rp.added.length > 0) {
          info(
            `html: added referrerpolicy="no-referrer" to ${rp.added.length} external <img>/<iframe> (hotlink protection)`,
          );
        }
        for (const w of rp.warnings) {
          warn(
            `<${w.tag}> at line ${w.line} has referrerpolicy="${w.existing}" (recommended: "no-referrer" for hotlink-protected hosts): ${w.src}`,
          );
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
