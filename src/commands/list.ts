import { Command } from 'commander';
import type { ProjectSummary } from '@zuroku/core';
import { fatal } from '../lib/console.js';
import { loadRuntimeConfig, makeClient } from '../lib/config.js';

interface ListOpts {
  baseUrl?: string;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function projectUrl(baseUrl: string, p: ProjectSummary): string {
  // Canonical URL: content origin の /p/<slug>。
  // baseUrl は app origin (Bearer 認証先) を指すので、`app.` → `content.` に置換する。
  // 置換できないカスタム base (localhost 等) はそのまま fallback。
  const root = baseUrl.replace(/\/+$/, '');
  const contentRoot = /^https?:\/\/app\./.test(root)
    ? root.replace(/^(https?:\/\/)app\./, '$1content.')
    : root;
  return `${contentRoot}/p/${p.slug}`;
}

function fmtDate(unixSec: number | null | undefined): string {
  if (!unixSec) return '-';
  // server は unix sec で返す (plan §3.2 Response 例)。
  const d = new Date(unixSec * 1000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function registerListCommand(parent: Command): void {
  parent
    .command('list')
    .description('List your published projects')
    .option('-u, --base-url <url>', 'Override API base URL')
    .action(async (opts: ListOpts) => {
      try {
        const config = await loadRuntimeConfig({ ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
        const client = makeClient(config);
        const projects = await client.list();

        if (projects.length === 0) {
          process.stdout.write('(no projects)\n');
          return;
        }

        // visibility は server 側で optional (旧 server 互換)。
        // 未返却 (旧 server) は '-' に倒して、private を curator と誤表示しないようにする。
        function visLabel(v: ProjectSummary['visibility']): string {
          if (v === 'private') return 'priv';
          if (v === 'curator') return 'cura';
          if (v === 'public') return 'pub';
          return '-';
        }

        const rows = projects.map((p) => ({
          slug: p.slug,
          title: p.title,
          vis: visLabel(p.visibility),
          published_at: fmtDate(p.published_at),
          url: projectUrl(config.base_url, p),
        }));

        const headers = {
          slug: 'slug',
          title: 'title',
          vis: 'vis',
          published_at: 'published_at',
          url: 'url',
        };
        const widths = {
          slug: Math.max(headers.slug.length, ...rows.map((r) => r.slug.length)),
          title: Math.max(headers.title.length, ...rows.map((r) => r.title.length)),
          vis: Math.max(headers.vis.length, ...rows.map((r) => r.vis.length)),
          published_at: Math.max(
            headers.published_at.length,
            ...rows.map((r) => r.published_at.length),
          ),
          url: Math.max(headers.url.length, ...rows.map((r) => r.url.length)),
        };

        const line = (r: typeof headers): string =>
          [
            pad(r.slug, widths.slug),
            pad(r.title, widths.title),
            pad(r.vis, widths.vis),
            pad(r.published_at, widths.published_at),
            r.url,
          ].join('  ');

        process.stdout.write(`${line(headers)}\n`);
        process.stdout.write(
          `${[
            '-'.repeat(widths.slug),
            '-'.repeat(widths.title),
            '-'.repeat(widths.vis),
            '-'.repeat(widths.published_at),
            '-'.repeat(widths.url),
          ].join('  ')}\n`,
        );
        for (const r of rows) {
          process.stdout.write(`${line(r)}\n`);
        }
      } catch (e) {
        fatal(e);
      }
    });
}
