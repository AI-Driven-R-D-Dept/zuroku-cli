import { describe, expect, it } from 'vitest';
import { ensureNoReferrerForExternal } from '../src/lib/referrer-policy.js';

describe('ensureNoReferrerForExternal', () => {
  it('外部 https の <img> に referrerpolicy="no-referrer" を付与する', () => {
    const html = '<img src="https://example.com/a.png" alt="x">';
    const { html: out, added, warnings } = ensureNoReferrerForExternal(html);
    expect(out).toBe('<img src="https://example.com/a.png" referrerpolicy="no-referrer" alt="x">');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ tag: 'img', src: 'https://example.com/a.png', line: 1 });
    expect(warnings).toHaveLength(0);
  });

  it('外部 https の <iframe> にも付与する', () => {
    const html = '<iframe src="https://embed.example.com/x"></iframe>';
    const { html: out, added } = ensureNoReferrerForExternal(html);
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(added[0]?.tag).toBe('iframe');
  });

  it('http (非 SSL) も対象', () => {
    const html = '<img src="http://legacy.example.com/a.png">';
    const { html: out, added } = ensureNoReferrerForExternal(html);
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(added).toHaveLength(1);
  });

  it('既に no-referrer が設定されていれば touch しない', () => {
    const html = '<img src="https://example.com/a.png" referrerpolicy="no-referrer">';
    const { html: out, added, warnings } = ensureNoReferrerForExternal(html);
    expect(out).toBe(html);
    expect(added).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('既存 referrerpolicy が no-referrer 以外なら warning を出すが書き換えない', () => {
    const html = '<img src="https://example.com/a.png" referrerpolicy="origin">';
    const { html: out, added, warnings } = ensureNoReferrerForExternal(html);
    expect(out).toBe(html);
    expect(added).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ tag: 'img', existing: 'origin' });
  });

  it('zuroku asset 参照 (img/foo.webp) は対象外', () => {
    const html = '<img src="img/foo.webp">';
    const { html: out, added } = ensureNoReferrerForExternal(html);
    expect(out).toBe(html);
    expect(added).toHaveLength(0);
  });

  it('data: / blob: URI は対象外', () => {
    const html = [
      '<img src="data:image/png;base64,iVBOR...">',
      '<img src="blob:https://app.zuroku.masao.ai/uuid">',
    ].join('\n');
    const { html: out, added } = ensureNoReferrerForExternal(html);
    expect(out).toBe(html);
    expect(added).toHaveLength(0);
  });

  it('self-closing (<img ... />) を壊さない', () => {
    const html = '<img src="https://example.com/a.png"/>';
    const { html: out } = ensureNoReferrerForExternal(html);
    expect(out).toBe('<img src="https://example.com/a.png" referrerpolicy="no-referrer"/>');
  });

  it('単一引用符の src も処理する', () => {
    const html = "<img src='https://example.com/a.png'>";
    const { html: out, added } = ensureNoReferrerForExternal(html);
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(added).toHaveLength(1);
  });

  it('大文字 tag / 属性 (案件由来 HTML) でも処理する', () => {
    const html = '<IMG SRC="https://example.com/a.png">';
    const { html: out, added } = ensureNoReferrerForExternal(html);
    // tag/attr 名は元の大小を維持 (HTML 仕様上どちらも有効) しつつ referrerpolicy を挿入
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(added).toHaveLength(1);
  });

  it('複数の外部 img に独立して付与する', () => {
    const html = [
      '<img src="https://a.example.com/1.png">',
      '<img src="img/local.webp">',
      '<img src="https://b.example.com/2.png" alt="b">',
    ].join('\n');
    const { html: out, added } = ensureNoReferrerForExternal(html);
    expect(added).toHaveLength(2);
    expect(out.match(/referrerpolicy="no-referrer"/g)).toHaveLength(2);
    // ローカル asset は無傷
    expect(out).toContain('<img src="img/local.webp">');
  });

  it('行番号を 1-based で報告する', () => {
    const html = ['<p>head</p>', '<p>mid</p>', '<img src="https://example.com/a.png">'].join('\n');
    const { added } = ensureNoReferrerForExternal(html);
    expect(added[0]?.line).toBe(3);
  });

  it('外部 <img> が無い HTML は素通し', () => {
    const html = '<!doctype html><html><body><img src="img/x.webp"></body></html>';
    const { html: out, added, warnings } = ensureNoReferrerForExternal(html);
    expect(out).toBe(html);
    expect(added).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('再実行 (idempotent) で 2 回目は何もしない', () => {
    const html = '<img src="https://example.com/a.png">';
    const first = ensureNoReferrerForExternal(html);
    const second = ensureNoReferrerForExternal(first.html);
    expect(second.html).toBe(first.html);
    expect(second.added).toHaveLength(0);
    expect(second.warnings).toHaveLength(0);
  });

  it('<a href="https://..."> (ナビゲーション) には付けない', () => {
    // <a> はナビゲーション。subresource ではないので hotlink 制限の対象外で、
    // referrerpolicy を付ける必要がない (本機能のスコープ外)。
    const html = '<a href="https://example.com/page">link</a>';
    const { html: out, added } = ensureNoReferrerForExternal(html);
    expect(out).toBe(html);
    expect(added).toHaveLength(0);
  });
});
