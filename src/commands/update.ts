import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  compressForUpload,
  passthroughForUpload,
  ZurokuClient,
  ZurokuError,
  type AssetUpload,
  type UploadPayload,
  type ZurokuConfig,
} from '@zuroku/core';
import { fatal, info, success, warn } from '../lib/console.js';
import { loadRuntimeConfig, makeClient } from '../lib/config.js';
import { scanLocalPathLeaks, formatLeakReport } from '../lib/preflight.js';
import { ensureNoReferrerForExternal } from '../lib/referrer-policy.js';
import { compressThumbToJpeg, isGifThumb, isThumbName } from '../lib/thumbnail.js';
import {
  extractHtmlAssetRefs,
  preflightErrorMessage,
  rewriteHtmlForRename,
  rewriteHtmlToServerAssets,
} from './publish.js';

const HTML_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

interface UpdateOpts {
  compress: boolean;
  keepAssets: boolean;
  baseUrl?: string;
  title?: string;
}

interface RepublishInitResponse {
  project_id: string;
  slug: string;
  upload_token: string;
}

interface RepublishResponse {
  id: string;
  slug: string;
  url: string;
  published_at?: number;
}

// ULID は大文字限定 (server の ulid() は常に大文字、slug は小文字のみ)。
// case-insensitive にすると 26 文字・ハイフン無しの合法 slug を id 誤判定して
// list() 解決を skip → 静かに 404 になる。core client の looksLikeId と同一判定。
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeId(s: string): boolean {
  return ULID_RE.test(s) || UUID_RE.test(s);
}

async function resolveProjectId(client: ZurokuClient, slugOrId: string): Promise<string> {
  if (looksLikeId(slugOrId)) return slugOrId;
  const projects = await client.list();
  const hit = projects.find((p) => p.slug === slugOrId || p.id === slugOrId);
  if (!hit) {
    throw new ZurokuError('NOT_FOUND', 404, `No project found for slug or id: ${slugOrId}`);
  }
  return hit.id;
}

/**
 * republish-init / republish endpoint は @zuroku/core@0.1.0 の ZurokuClient には
 * 未実装なので、CLI 側で raw fetch する。html/asset PUT は既存の public method
 * (uploadHtml / uploadAsset) を upload_token と一緒に呼べば素直に流用できる。
 */
async function callRepublishApi<T>(
  config: ZurokuConfig,
  pathname: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const base = config.base_url.replace(/\/+$/, '');
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      const code = j.error?.code ?? 'HTTP_ERROR';
      const msg = j.error?.message ?? res.statusText;
      throw new ZurokuError(code, res.status, `${msg} (${pathname})`);
    } catch (e) {
      if (e instanceof ZurokuError) throw e;
      detail = await res.text().catch(() => '');
      throw new ZurokuError('HTTP_ERROR', res.status, `${res.statusText} (${pathname}) ${detail}`);
    }
  }
  return (await res.json()) as T;
}

/**
 * 既存 project の asset filename 一覧をサーバから取得する (GET /api/projects/:id)。
 * --keep-assets で「HTML が参照する img/ がサーバに温存されているか」を照合し、
 * 参照名を変えたまま keep-assets すると沈黙して 404 になる事故を warn で防ぐため。
 */
async function fetchProjectAssetFilenames(
  config: ZurokuConfig,
  projectId: string,
): Promise<Set<string>> {
  const base = config.base_url.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${config.token}` },
  });
  if (!res.ok) {
    throw new Error(`GET /api/projects/${projectId} -> ${res.status}`);
  }
  const j = (await res.json()) as { assets?: Array<{ filename: string }> };
  return new Set((j.assets ?? []).map((a) => a.filename));
}

/**
 * 既存 project の登録タイトルを変更する (PATCH /api/projects/:id)。
 * republish は本文/画像のみ差し替えで登録タイトルを変えないため、`zuroku update --title`
 * の実体として使う。
 */
async function patchProjectTitle(
  config: ZurokuConfig,
  projectId: string,
  title: string,
): Promise<void> {
  const base = config.base_url.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new ZurokuError(
      j.error?.code ?? 'HTTP_ERROR',
      res.status,
      `title update failed: ${j.error?.message ?? res.statusText}`,
    );
  }
}

export function registerUpdateCommand(parent: Command): void {
  parent
    .command('update')
    .description('Republish an existing project, keeping its slug/URL (HTML + asset replace)')
    .argument('<slug-or-id>', 'Existing project slug or id (URL part after /p/)')
    .argument('<html>', 'Path to the new HTML file (<= 5 MiB)')
    .argument('[images...]', 'Image files to upload as the new asset set (full replacement)')
    .option('--no-compress', 'Skip image compression (upload originals)')
    .option(
      '--keep-assets',
      'Update HTML only and keep all existing images untouched (ignores [images...])',
    )
    .option(
      '-T, --title <title>',
      "Also change the project's registered title (otherwise the title is kept from the original publish)",
    )
    .option('-u, --base-url <url>', 'Override API base URL')
    .action(async (slugOrId: string, htmlArg: string, images: string[], opts: UpdateOpts) => {
      try {
        const config = await loadRuntimeConfig({ ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });

        // ---- --title 事前 validation -------------------------------------
        // title PATCH は republish の後段に走るため、ここで弾かないと「本文 republish 済 +
        // タイトル PATCH 失敗」の部分適用になる。server と同じ制約 (非空 / <=200) を先に検査。
        if (opts.title !== undefined) {
          const t = opts.title.trim();
          if (!t) throw new ZurokuError('INVALID_INPUT', 0, '--title must not be empty');
          if (t.length > 200) {
            throw new ZurokuError('INVALID_INPUT', 0, `--title exceeds 200 chars (got ${t.length})`);
          }
        }

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

        // ---- Assets (publish と同じ rule: compress 時は .webp に rename) -------
        // keep-assets モードでは画像を一切送らず既存 asset を温存する。引数で渡された
        // 画像は無視する (誤って渡しても削除事故にならないよう warn だけ出す)。
        const assets: AssetUpload[] = [];
        const renameMap: Array<{ from: string; to: string }> = [];
        if (opts.keepAssets && images.length > 0) {
          warn(
            `--keep-assets specified: ignoring ${images.length} image arg(s); existing images are kept as-is`,
          );
        }
        for (const img of opts.keepAssets ? [] : images) {
          const abs = path.resolve(img);
          const label = path.basename(abs);
          // thumb (OG 画像) は WebP だと LinkedIn/Facebook/LINE 等の unfurl で描画されない
          // ため JPEG に変換する。GIF thumb はアニメ保持のため対象外 (通常処理に回す)。
          let payload: UploadPayload;
          if (opts.compress && isThumbName(label) && !isGifThumb(label)) {
            payload = await compressThumbToJpeg(abs);
          } else if (opts.compress) {
            payload = await compressForUpload(abs);
          } else {
            payload = await passthroughForUpload(abs);
            if (isThumbName(label) && payload.contentType === 'image/webp') {
              warn(
                'thumb.* が WebP です。OG/SNS unfurl (LinkedIn/Facebook/LINE) で表示されない場合があります。サムネは PNG/JPEG 推奨。',
              );
            }
          }
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
        const htmlOriginal = htmlBuf.toString('utf8');
        const providedFilenames = assets.map((a) => a.filename);
        let htmlText = rewriteHtmlForRename(htmlOriginal, renameMap, providedFilenames);
        if (htmlText !== htmlOriginal) {
          info(`html: rewrote img src references (path normalize / extension rename)`);
        }

        // ---- HTML auto-rewrite (hotlink protection: 外部 subresource に referrerpolicy) -----
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

        let htmlForUpload = htmlText !== htmlOriginal ? Buffer.from(htmlText, 'utf8') : htmlBuf;

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

        // ---- Preflight ----------------------------------------------------
        // keep-assets モードでは HTML が参照する img/* はサーバ側に温存されている前提
        // (ローカルに無くて当然) なので asset 欠落チェックは行わない。
        if (!opts.keepAssets && process.env.ZUROKU_SKIP_PREFLIGHT !== '1') {
          const { references, expectedFilenames } = extractHtmlAssetRefs(htmlText);
          const provided = new Set(providedFilenames);
          const missing = [...expectedFilenames].filter((f) => !provided.has(f));
          const nonImg = references.filter(
            (r) => !/^(?:\.\/)?img\//.test(r) && !/^\/?(style|css|js|favicon)/i.test(r) && !/^[a-z]+:/i.test(r),
          );
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

        // ---- Republish flow ----------------------------------------------
        const client = makeClient(config);
        info(`resolving "${slugOrId}"...`);
        const projectId = await resolveProjectId(client, slugOrId);
        info(`project_id=${projectId}`);

        // ---- keep-assets: HTML のローカル画像参照をサーバ既存 asset に揃える --------
        // keep-assets は新規 asset を送らない (provided が空) ため、上の
        // rewriteHtmlForRename の path/拡張子正規化が効かない。ソース HTML が
        // `images/foo.png` のままだとサーバの `img/foo.webp` を指さず全画像 404 になる
        // (実際に踏まれた事故)。サーバの filename を取得し stem 一致で
        // `(?:img|images)/<file>` → `img/<serverfile>` に揃える。属性値スコープで処理し
        // 絶対 URL は触らない。解決できない参照は warn。
        // 注: これは validation ではなく correctness のための transform なので
        // ZUROKU_SKIP_PREFLIGHT では無効化しない (skip で 404 バグが再発しないように)。
        if (opts.keepAssets) {
          try {
            const existing = await fetchProjectAssetFilenames(config, projectId);
            const rw = rewriteHtmlToServerAssets(htmlText, [...existing]);
            if (rw.rewritten.length > 0) {
              htmlText = rw.html;
              htmlForUpload = Buffer.from(htmlText, 'utf8');
              info(
                `html: rewrote ${rw.rewritten.length} local img ref(s) to existing server assets (keep-assets)`,
              );
            }
            if (rw.unmatched.length > 0) {
              warn(
                '--keep-assets: HTML references images not present on the server ' +
                  '(these will 404 — fix the refs or re-run without --keep-assets and pass every image):',
              );
              for (const u of rw.unmatched) warn(`  - ${u}`);
            }
          } catch (e) {
            // 取得失敗は致命ではない (republish は続行)。照合/rewrite だけ skip。
            warn(
              `--keep-assets: could not verify existing assets (${(e as Error).message ?? String(e)}); skipping reference check`,
            );
          }
        }

        const initBody = opts.keepAssets
          ? { keep_assets: true }
          : { asset_filenames: assets.map((a) => a.filename) };
        info(
          opts.keepAssets
            ? 'republish-init: keep-assets mode (HTML only, existing images preserved)...'
            : `republish-init: declaring ${assets.length} asset(s)...`,
        );
        const init = await callRepublishApi<RepublishInitResponse>(
          config,
          `/api/projects/${encodeURIComponent(projectId)}/republish-init`,
          initBody,
        );

        info('uploading html + assets...');
        await Promise.all([
          client.uploadHtml(projectId, init.upload_token, htmlForUpload),
          ...assets.map((a) =>
            client.uploadAsset(projectId, init.upload_token, a.filename, a.buffer, a.contentType),
          ),
        ]);

        info('republish: swapping manifest...');
        const res = await callRepublishApi<RepublishResponse>(
          config,
          `/api/projects/${encodeURIComponent(projectId)}/republish`,
          {},
          { 'X-Upload-Token': init.upload_token },
        );

        success(`updated: slug=${res.slug} id=${res.id}`);

        // ---- title 変更 (任意) -------------------------------------------
        // republish は本文/画像のみ差し替え、登録タイトル (一覧 / OG / og:title) は
        // 初回 publish の値のまま。--title 指定時は PATCH /api/projects/:id で更新する
        // (HTML の <title> タグを直すだけでは登録タイトルは変わらない)。
        if (opts.title !== undefined && opts.title.trim()) {
          const t = opts.title.trim();
          info(`updating registered title to "${t}"...`);
          await patchProjectTitle(config, projectId, t);
          success('title updated');
        }

        process.stdout.write(`${res.url}\n`);
      } catch (e) {
        fatal(e);
      }
    });
}
