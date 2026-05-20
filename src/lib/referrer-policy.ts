/**
 * Hotlink protection 回避のため、外部 subresource (`<img>` / `<iframe>`) に
 * `referrerpolicy="no-referrer"` を自動付与する。
 *
 * 背景: 配信ドメイン (app.zuroku.masao.ai) を Referer に載せると X / 一部 CDN /
 * 報道サイト等の hotlink protection が 403 / placeholder を返す。
 * curl / fetch で叩くと 200 が返るので「リンク切れ」と誤認されやすいが、
 * 実体は Referer 起因。`Referer: ` を空にすれば大半は通る。
 *
 * 設計方針:
 * - 対象 tag: `<img>` と `<iframe>` (subresource。`<a>` はナビゲーションなので対象外)
 * - 対象 src: 絶対 URL (`https?://`) のみ。`data:` / `blob:` / `img/<basename>`
 *   (zuroku asset) は触らない。
 * - 既に `referrerpolicy` が設定されていれば触らない。値が `no-referrer` 以外なら
 *   `warnings` に積んで呼び出し側で報告する (誤設定 hint)。
 * - HTML serialization は case-insensitive なので tag/attr 名は両 case に対応。
 */

export interface ReferrerPolicyAdd {
  tag: 'img' | 'iframe';
  src: string;
  line: number;
}

export interface ReferrerPolicyWarning {
  tag: 'img' | 'iframe';
  src: string;
  existing: string;
  line: number;
}

export interface ReferrerPolicyResult {
  html: string;
  added: ReferrerPolicyAdd[];
  warnings: ReferrerPolicyWarning[];
}

const TAG_RE = /<(img|iframe)\b([^>]*)>/gi;

function buildLineLookup(html: string): (offset: number) => number {
  const lineStartOffsets: number[] = [0];
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 10 /* \n */) lineStartOffsets.push(i + 1);
  }
  return (offset: number) => {
    let lo = 0;
    let hi = lineStartOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStartOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function ensureNoReferrerForExternal(html: string): ReferrerPolicyResult {
  const added: ReferrerPolicyAdd[] = [];
  const warnings: ReferrerPolicyWarning[] = [];
  const lineFor = buildLineLookup(html);

  const out = html.replace(TAG_RE, (full, tagName: string, attrs: string, offset: number) => {
    const lowerTag = tagName.toLowerCase() as 'img' | 'iframe';
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!srcMatch) return full;
    const src = srcMatch[1]!;
    // 絶対 URL でない (= zuroku asset / data URI / 相対) なら hotlink 対象外
    if (!/^https?:\/\//i.test(src)) return full;

    const rpMatch = /\breferrerpolicy\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (rpMatch) {
      const existing = rpMatch[1]!.trim().toLowerCase();
      if (existing !== 'no-referrer') {
        warnings.push({ tag: lowerTag, src, existing, line: lineFor(offset) });
      }
      return full;
    }

    // src 属性の直後に挿入 (人間が読んでも diff が追いやすい順序)
    const insertAt = srcMatch.index + srcMatch[0].length;
    const newAttrs =
      attrs.slice(0, insertAt) + ' referrerpolicy="no-referrer"' + attrs.slice(insertAt);
    added.push({ tag: lowerTag, src, line: lineFor(offset) });
    return `<${tagName}${newAttrs}>`;
  });

  return { html: out, added, warnings };
}
