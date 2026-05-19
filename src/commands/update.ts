import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  compressForUpload,
  passthroughForUpload,
  ZurokuClient,
  ZurokuError,
  type AssetUpload,
  type ZurokuConfig,
} from '@zuroku/core';
import { fatal, info, success, warn } from '../lib/console.js';
import { loadRuntimeConfig, makeClient } from '../lib/config.js';
import { scanLocalPathLeaks, formatLeakReport } from '../lib/preflight.js';
import {
  extractHtmlAssetRefs,
  preflightErrorMessage,
  rewriteHtmlForRename,
} from './publish.js';

const HTML_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

interface UpdateOpts {
  compress: boolean;
  baseUrl?: string;
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

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
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

export function registerUpdateCommand(parent: Command): void {
  parent
    .command('update')
    .description('Republish an existing project, keeping its slug/URL (HTML + asset replace)')
    .argument('<slug-or-id>', 'Existing project slug or id (URL part after /p/)')
    .argument('<html>', 'Path to the new HTML file (<= 5 MiB)')
    .argument('[images...]', 'Image files to upload as the new asset set (full replacement)')
    .option('--no-compress', 'Skip image compression (upload originals)')
    .option('-u, --base-url <url>', 'Override API base URL')
    .action(async (slugOrId: string, htmlArg: string, images: string[], opts: UpdateOpts) => {
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

        // ---- Assets (publish と同じ rule: compress 時は .webp に rename) -------
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
        const htmlOriginal = htmlBuf.toString('utf8');
        const providedFilenames = assets.map((a) => a.filename);
        const htmlText = rewriteHtmlForRename(htmlOriginal, renameMap, providedFilenames);
        if (htmlText !== htmlOriginal) {
          info(`html: rewrote img src references (path normalize / extension rename)`);
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

        // ---- Preflight ----------------------------------------------------
        if (process.env.ZUROKU_SKIP_PREFLIGHT !== '1') {
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

        info(`republish-init: declaring ${assets.length} asset(s)...`);
        const init = await callRepublishApi<RepublishInitResponse>(
          config,
          `/api/projects/${encodeURIComponent(projectId)}/republish-init`,
          { asset_filenames: assets.map((a) => a.filename) },
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
        process.stdout.write(`${res.url}\n`);
      } catch (e) {
        fatal(e);
      }
    });
}
