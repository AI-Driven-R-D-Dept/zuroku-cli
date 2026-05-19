/**
 * Local-path leak scanner.
 *
 * preflight (publish.ts の `extractHtmlAssetRefs` 周り) は asset 参照 (src/href/poster)
 * しか見ないので、本文中の引用 / `<code>` / `<script>` / `data-*` 等に混入した
 * 「viewer 環境では絶対に解決しない local-only path」は素通りしてしまう。
 * ここでは HTML 全体を text として scan し、明らかに作者マシンを露呈/破綻させる
 * pattern (`/Users/...`, `file://`, `C:\Users\...` 等) を検出する。
 *
 * 設計方針:
 * - error: 99% leak と言い切れるもの (個人 home / file:// scheme / macOS tmpdir)
 * - warn:  正当な技術引用と区別が難しいもの (`~/`, `../../` 等は本文中によくある)
 * - `/etc`, `/usr`, `/bin`, `/var/log` 等の system path は意図的に除外
 *   (技術記事の正当な引用が大半なので noise になる)
 */

export type LeakSeverity = 'error' | 'warn';

export interface LeakHit {
  /** pattern identifier (報告とテスト用) */
  pattern: string;
  severity: LeakSeverity;
  /** マッチした実テキスト */
  match: string;
  /** 1-based line number */
  line: number;
  /** 当該行を 120 文字までトリムした抜粋 */
  excerpt: string;
}

interface LeakPattern {
  name: string;
  re: RegExp;
  severity: LeakSeverity;
}

// 各 RegExp は global / 必要なら multiline / case-insensitive
// IMPORTANT: capture group は使わない (m[0] のみで報告するため)
const LEAK_PATTERNS: LeakPattern[] = [
  // macOS 個人 home (作者マシン露呈の代表例)
  { name: 'macos_user', re: /\/Users\/[A-Za-z0-9._-]+\/[^\s"'<>)]*/g, severity: 'error' },
  // Linux 個人 home (システム/コンテナの場合あるが ~/ より特定性高い)
  { name: 'linux_home', re: /\/home\/[A-Za-z0-9._-]+\/[^\s"'<>)]*/g, severity: 'error' },
  // file:// URI (本文中・属性中問わず leak の確定)
  { name: 'file_uri', re: /\bfile:\/\/[^\s"'<>)]+/gi, severity: 'error' },
  // Windows 個人 path (Users/Documents/Desktop directly under drive letter)
  { name: 'windows_user', re: /\b[A-Za-z]:\\(?:Users|Documents|Desktop)\\[^\s"'<>)]+/g, severity: 'error' },
  // macOS tmpdir (TMPDIR の typical layout)
  { name: 'macos_tmp', re: /\/(?:private\/)?var\/folders\/[A-Za-z0-9_]{1,3}\/[A-Za-z0-9._+/-]+/g, severity: 'error' },
  // ~/ 展開 (本文中によく出るが、PATH っぽく続いてるものは warn)
  { name: 'home_tilde', re: /(?<=^|[\s"'(>])~\/[A-Za-z0-9._-][^\s"'<>)]*/g, severity: 'warn' },
];

/**
 * HTML body を全体 scan し、leak の疑いがある文字列を行番号付きで返す。
 *
 * - 同一行に複数 hit がある場合はそれぞれ別 entry になる (重複報告は許容)
 * - HTML entity / URL encode 経由の難読化は対象外 (現実的な leak の 95% は raw)
 */
export function scanLocalPathLeaks(html: string): LeakHit[] {
  // line offset の計算を高速化: \n の累積 offset を 1 度だけ走査
  const lineStartOffsets: number[] = [0];
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 10 /* \n */) lineStartOffsets.push(i + 1);
  }
  const lineForOffset = (offset: number): number => {
    // binary search; lineStartOffsets[i] <= offset < lineStartOffsets[i+1]
    let lo = 0;
    let hi = lineStartOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStartOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  };
  const lineText = (lineNum: number): string => {
    const start = lineStartOffsets[lineNum - 1] ?? 0;
    const end = lineStartOffsets[lineNum] ?? html.length;
    return html.slice(start, end).replace(/\r?\n$/, '');
  };

  const hits: LeakHit[] = [];
  for (const { name, re, severity } of LEAK_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const line = lineForOffset(m.index);
      const excerpt = lineText(line).trim().slice(0, 120);
      hits.push({ pattern: name, severity, match: m[0], line, excerpt });
      // zero-width 防御 (re が空マッチに陥らないように)
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  // 行番号順 → pattern 順で安定 sort
  hits.sort((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern));
  return hits;
}

/** AI agent / 人間向けの詳細レポート (LOCAL_PATH_LEAK error 用)。 */
export function formatLeakReport(htmlPath: string, hits: LeakHit[]): string {
  const lines: string[] = [];
  lines.push(`Found ${hits.length} local-only path reference(s) in HTML:`);
  lines.push('');
  lines.push(`HTML file: ${htmlPath}`);
  lines.push('');
  for (const h of hits) {
    lines.push(`  line ${String(h.line).padStart(4)}  [${h.pattern}]  ${h.match}`);
    lines.push(`            ${h.excerpt}`);
  }
  lines.push('');
  lines.push('These paths only work on the author\'s machine and will appear broken to viewers.');
  lines.push('Fix options:');
  lines.push('  - Remove the absolute path (most citations don\'t need the full path)');
  lines.push('  - Replace with a public URL');
  lines.push('  - Strip the leaked filename and refer to it abstractly');
  lines.push('');
  lines.push('To bypass this check (NOT recommended), set ZUROKU_SKIP_PREFLIGHT=1.');
  return lines.join('\n');
}
