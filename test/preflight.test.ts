import { describe, expect, it } from 'vitest';
import { scanLocalPathLeaks, formatLeakReport } from '../src/lib/preflight.js';

describe('scanLocalPathLeaks', () => {
  it('catches macOS /Users/<name>/... in body text', () => {
    const html = [
      '<!doctype html><html><body>',
      '<p>参考: <code>/Users/masao/playground/demo/notes.md</code></p>',
      '</body></html>',
    ].join('\n');
    const hits = scanLocalPathLeaks(html);
    const macos = hits.filter((h) => h.pattern === 'macos_user');
    expect(macos).toHaveLength(1);
    expect(macos[0]!.severity).toBe('error');
    expect(macos[0]!.line).toBe(2);
    expect(macos[0]!.match.startsWith('/Users/masao/')).toBe(true);
  });

  it('catches file:// URI in href', () => {
    const html = '<a href="file:///Users/masao/Desktop/foo.png">backup</a>';
    const hits = scanLocalPathLeaks(html);
    expect(hits.some((h) => h.pattern === 'file_uri' && h.severity === 'error')).toBe(true);
  });

  it('catches Linux /home/<name>/... and Windows C:\\Users\\...', () => {
    const html = [
      '<p>see /home/ubuntu/repo/data.csv</p>',
      '<p>and C:\\Users\\foo\\report.pdf</p>',
    ].join('\n');
    const hits = scanLocalPathLeaks(html);
    expect(hits.some((h) => h.pattern === 'linux_home')).toBe(true);
    expect(hits.some((h) => h.pattern === 'windows_user')).toBe(true);
    expect(hits.every((h) => h.severity === 'error')).toBe(true);
  });

  it('catches macOS tmpdir (/var/folders/...)', () => {
    const html = '<pre>cached at /var/folders/xx/abc123/T/zuroku-tmp.json</pre>';
    const hits = scanLocalPathLeaks(html);
    expect(hits.some((h) => h.pattern === 'macos_tmp' && h.severity === 'error')).toBe(true);
  });

  it('flags ~/ as warn only (technical articles legitimately use it)', () => {
    const html = '<p>run from ~/projects/foo</p>';
    const hits = scanLocalPathLeaks(html);
    const tilde = hits.find((h) => h.pattern === 'home_tilde');
    expect(tilde?.severity).toBe('warn');
  });

  it('does NOT flag system paths (/etc, /usr, /bin, /var/log)', () => {
    const html = [
      '<p>edit /etc/hosts</p>',
      '<p>install to /usr/local/bin</p>',
      '<p>tail /var/log/system.log</p>',
    ].join('\n');
    const hits = scanLocalPathLeaks(html);
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag public URLs even if they contain /Users-ish substrings', () => {
    const html = '<a href="https://example.com/Users/help">docs</a>';
    const hits = scanLocalPathLeaks(html);
    // /Users/help/ がマッチしないこと (連続する `/` の前に scheme 由来の context)
    expect(hits.filter((h) => h.pattern === 'macos_user')).toHaveLength(0);
  });

  it('reports correct line numbers across multi-line HTML', () => {
    const html = [
      'line 1',
      'line 2 with /Users/alice/foo.md',
      'line 3',
      'line 4 with file:///etc/passwd',
    ].join('\n');
    const hits = scanLocalPathLeaks(html);
    const lineByPattern = new Map(hits.map((h) => [h.pattern, h.line] as const));
    expect(lineByPattern.get('macos_user')).toBe(2);
    expect(lineByPattern.get('file_uri')).toBe(4);
  });

  it('returns no hits for clean HTML', () => {
    const html = '<!doctype html><html><body><h1>Hello</h1><img src="img/x.webp"></body></html>';
    expect(scanLocalPathLeaks(html)).toHaveLength(0);
  });

  it('does not infinite-loop on zero-width regex edge cases', () => {
    // ensure the lastIndex advancement guard works
    const html = '/Users/a/\n'.repeat(50);
    const hits = scanLocalPathLeaks(html);
    expect(hits.length).toBeGreaterThan(0);
    // 50 行 × 1 pattern = 50 件以下に収まり、永久ループしないこと
    expect(hits.length).toBeLessThan(200);
  });
});

describe('formatLeakReport', () => {
  it('renders a multi-line, AI-agent-friendly report', () => {
    const hits = scanLocalPathLeaks(
      [
        '<p>引用: /Users/masao/playground/foo</p>',
        '<a href="file:///tmp/note.md">x</a>',
      ].join('\n'),
    );
    const report = formatLeakReport('/tmp/test.html', hits);
    expect(report).toContain('Found');
    expect(report).toContain('/tmp/test.html');
    expect(report).toContain('[macos_user]');
    expect(report).toContain('[file_uri]');
    expect(report).toContain('ZUROKU_SKIP_PREFLIGHT=1');
  });
});
