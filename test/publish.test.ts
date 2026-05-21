// `zuroku publish` の registerPublishCommand を Command に登録して、
// --visibility / --private option が help に出ること、option 値域 validation の
// 等価ロジックが正しく動くことを確認する unit test.

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  registerPublishCommand,
  rewriteHtmlForRename,
  rewriteHtmlToServerAssets,
} from '../src/commands/publish.js';

function makeProgram(): Command {
  const program = new Command();
  program.name('zuroku').exitOverride(); // commander の process.exit を抑止
  // help 出力を string に capture するため configureOutput を上書き
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerPublishCommand(program);
  return program;
}

describe('registerPublishCommand', () => {
  it('publish --help に visibility / private option が含まれる', async () => {
    const program = makeProgram();
    const publish = program.commands.find((c) => c.name() === 'publish');
    expect(publish).toBeDefined();
    const helpText = publish!.helpInformation();
    expect(helpText).toContain('--visibility');
    expect(helpText).toContain('--private');
    // 説明文は揺れるが 'private' と 'curator' は必ず登場する
    expect(helpText).toMatch(/private/);
    expect(helpText).toMatch(/curator/);
  });

  it('publish に title / html / images の必須シグネチャが登録されている', () => {
    const program = makeProgram();
    const publish = program.commands.find((c) => c.name() === 'publish')!;
    // Commander の option 群を inspect
    const optNames = publish.options.map((o) => o.long);
    expect(optNames).toContain('--title');
    expect(optNames).toContain('--slug');
    expect(optNames).toContain('--description');
    expect(optNames).toContain('--no-compress');
    expect(optNames).toContain('--base-url');
    expect(optNames).toContain('--visibility');
    expect(optNames).toContain('--private');
  });

  it('--help 経由でも CLI 構造を壊さない (commanderHelp 例外を raise する)', async () => {
    const program = makeProgram();
    // --help を投げると commander は CommanderError(code=commander.helpDisplayed) を throw
    let raised: unknown = null;
    try {
      await program.parseAsync(['node', 'zuroku', 'publish', '--help']);
    } catch (e) {
      raised = e;
    }
    expect(raised).not.toBeNull();
    // commander 12 では `code` プロパティに 'commander.helpDisplayed' が入る
    const err = raised as { code?: string };
    expect(err.code === 'commander.helpDisplayed' || err.code === 'commander.help').toBe(true);
  });
});

// --- option 値域 validation を切り出した等価関数 (publish.ts の handler 内ロジックを反映) ---
// publish.ts では --private で 'private' に固定、--visibility の許可値は 'private'|'curator' のみ。
// この helper は handler 内 logic を本ファイルでも検証するため独立に再現したもの (drift 監視用)。
function resolveVisibility(opts: {
  visibility?: string;
  private?: boolean;
}): 'private' | 'curator' | undefined {
  if (opts.private) return 'private';
  if (opts.visibility === undefined) return undefined;
  if (opts.visibility !== 'private' && opts.visibility !== 'curator') {
    throw new Error(`--visibility must be 'private' or 'curator' (got '${opts.visibility}')`);
  }
  return opts.visibility;
}

describe('resolveVisibility (publish.ts handler logic と同等)', () => {
  it('--private は visibility を private に強制する', () => {
    expect(resolveVisibility({ private: true })).toBe('private');
    // --private が立っていれば --visibility curator も上書きされる
    expect(resolveVisibility({ private: true, visibility: 'curator' })).toBe('private');
  });

  it('--visibility curator → curator', () => {
    expect(resolveVisibility({ visibility: 'curator' })).toBe('curator');
  });

  it('--visibility private → private', () => {
    expect(resolveVisibility({ visibility: 'private' })).toBe('private');
  });

  it('未指定 → undefined (server default 採用)', () => {
    expect(resolveVisibility({})).toBeUndefined();
  });

  it('--visibility public は許可しない (init 400 invalid_value 規範と一致)', () => {
    expect(() => resolveVisibility({ visibility: 'public' })).toThrow(/must be/);
  });

  it.each(['Public', 'PRIVATE', 'foo', ''])('不正値 (%s) は throw', (bad) => {
    expect(() => resolveVisibility({ visibility: bad })).toThrow();
  });
});

describe('rewriteHtmlForRename (compress 時の HTML img src 自動 rewrite)', () => {
  it('img/foo.png → img/foo.webp を 1 つ rewrite する', () => {
    const html = '<img src="img/foo.png" alt="x">';
    const out = rewriteHtmlForRename(html, [{ from: 'foo.png', to: 'foo.webp' }]);
    expect(out).toBe('<img src="img/foo.webp" alt="x">');
  });

  it('複数 asset を全部 rewrite する', () => {
    const html = '<img src="img/a.png"><img src="img/b.jpg"><img src="img/c.png">';
    const out = rewriteHtmlForRename(html, [
      { from: 'a.png', to: 'a.webp' },
      { from: 'b.jpg', to: 'b.webp' },
      { from: 'c.png', to: 'c.webp' },
    ]);
    expect(out).toBe('<img src="img/a.webp"><img src="img/b.webp"><img src="img/c.webp">');
  });

  it('外部 URL 内の images/<非provided> は壊さない (global sed と違い provided にアンカー)', () => {
    // skill TL;DR の素朴な `sed 's|images/|img/|g'` だと外部 URL も壊れるが、
    // rewriteHtmlForRename は provided filename にアンカーするので外部 URL は無傷。
    const html =
      '<img src="https://storage.googleapis.com/x/images/hero.max-1200.webp">' +
      '<img src="images/foo.png">';
    const out = rewriteHtmlForRename(html, [{ from: 'foo.png', to: 'foo.webp' }], ['foo.webp']);
    expect(out).toBe(
      '<img src="https://storage.googleapis.com/x/images/hero.max-1200.webp">' +
        '<img src="img/foo.webp">',
    );
  });

  it('img/ や images/ 以外の prefix (assets/, style/) は触らない (CSS/JS path 保護)', () => {
    const html = '<link href="style/foo.png">\n<img src="assets/foo.png">';
    const out = rewriteHtmlForRename(html, [{ from: 'foo.png', to: 'foo.webp' }]);
    expect(out).toBe(html); // 不変
  });

  it('images/ (複数形) prefix を img/ に正規化しつつ拡張子も rewrite する', () => {
    const html = '<img src="images/foo.png"><img src="images/bar.jpg">';
    const out = rewriteHtmlForRename(html, [
      { from: 'foo.png', to: 'foo.webp' },
      { from: 'bar.jpg', to: 'bar.webp' },
    ]);
    expect(out).toBe('<img src="img/foo.webp"><img src="img/bar.webp">');
  });

  it('--no-compress 相当: renameMap 空 + providedFilenames で images/ → img/ 正規化', () => {
    const html = '<img src="images/foo.png">';
    const out = rewriteHtmlForRename(html, [], ['foo.png']);
    expect(out).toBe('<img src="img/foo.png">');
  });

  it('providedFilenames は path 正規化のみで拡張子は変えない', () => {
    const html = '<img src="images/foo.gif">';
    // GIF は passthrough なので filename そのまま
    const out = rewriteHtmlForRename(html, [], ['foo.gif']);
    expect(out).toBe('<img src="img/foo.gif">');
  });

  it('部分一致 (foo.png.bak) は rewrite しない', () => {
    const html = '<a href="img/foo.png.bak">';
    const out = rewriteHtmlForRename(html, [{ from: 'foo.png', to: 'foo.webp' }]);
    expect(out).toBe(html);
  });

  it('srcset の空白区切りも rewrite する', () => {
    const html = '<img srcset="img/a.png 1x, img/a@2x.png 2x">';
    const out = rewriteHtmlForRename(html, [
      { from: 'a.png', to: 'a.webp' },
      { from: 'a@2x.png', to: 'a@2x.webp' },
    ]);
    expect(out).toBe('<img srcset="img/a.webp 1x, img/a@2x.webp 2x">');
  });

  it('from === to のエントリは skip (passthrough 時の no-op)', () => {
    const html = '<img src="img/foo.gif">';
    const out = rewriteHtmlForRename(html, [{ from: 'foo.gif', to: 'foo.gif' }]);
    expect(out).toBe(html);
  });

  it('renameMap 空配列は byte 一致で素通し', () => {
    const html = '<img src="img/foo.png">';
    expect(rewriteHtmlForRename(html, [])).toBe(html);
  });

  it('特殊文字 (() を含む filename も escape して rewrite する', () => {
    const html = '<img src="img/foo(1).png">';
    const out = rewriteHtmlForRename(html, [{ from: 'foo(1).png', to: 'foo(1).webp' }]);
    expect(out).toBe('<img src="img/foo(1).webp">');
  });

  it('unquoted 属性 (src=img/foo.png>) も rewrite する (`>` 境界)', () => {
    const html = '<img src=img/foo.png>';
    const out = rewriteHtmlForRename(html, [{ from: 'foo.png', to: 'foo.webp' }]);
    expect(out).toBe('<img src=img/foo.webp>');
  });

  it('`>` 境界を足しても部分一致 (img/foo.png.bak) は rewrite しない', () => {
    const html = '<a href="img/foo.png.bak">';
    const out = rewriteHtmlForRename(html, [{ from: 'foo.png', to: 'foo.webp' }]);
    expect(out).toBe(html);
  });
});


describe('rewriteHtmlToServerAssets (--keep-assets: サーバ既存 asset に揃える)', () => {
  it('images/foo.png をサーバの img/foo.webp に揃える (stem 一致・拡張子差)', () => {
    const html = '<img src="images/concept-01.png" alt="x">';
    const r = rewriteHtmlToServerAssets(html, ['concept-01.webp']);
    expect(r.html).toBe('<img src="img/concept-01.webp" alt="x">');
    expect(r.rewritten).toEqual(['images/concept-01.png']);
    expect(r.unmatched).toEqual([]);
  });

  it('外部 URL (絶対) は値全体を skip して触らない', () => {
    const html =
      '<img src="https://cdn.example.com/images/concept-01.webp">' +
      '<img src="images/concept-01.png">';
    const r = rewriteHtmlToServerAssets(html, ['concept-01.webp']);
    expect(r.html).toBe(
      '<img src="https://cdn.example.com/images/concept-01.webp">' +
        '<img src="img/concept-01.webp">',
    );
    expect(r.rewritten).toEqual(['images/concept-01.png']);
  });

  it('外部 URL のクエリ内 images/ も触らない (codex HIGH 回帰)', () => {
    const html = '<img src="https://proxy.example.com/r?u=images/concept-01.png&w=800">';
    const r = rewriteHtmlToServerAssets(html, ['concept-01.webp']);
    expect(r.html).toBe(html); // 不変
    expect(r.rewritten).toEqual([]);
  });

  it('protocol-relative URL (//cdn/...) も触らない', () => {
    const html = '<img src="//cdn.example.com/images/concept-01.png">';
    const r = rewriteHtmlToServerAssets(html, ['concept-01.webp']);
    expect(r.html).toBe(html);
  });

  it('srcset の comma-no-space 候補も両方揃える (subagent MED 回帰)', () => {
    const html = '<img srcset="images/a.png 1x,images/b.png 2x">';
    const r = rewriteHtmlToServerAssets(html, ['a.webp', 'b.webp']);
    expect(r.html).toBe('<img srcset="img/a.webp 1x, img/b.webp 2x">');
    expect(r.unmatched).toEqual([]);
  });

  it('unquoted 属性 (src=img/a.png>) も揃える', () => {
    const html = '<img src=images/a.png>';
    const r = rewriteHtmlToServerAssets(html, ['a.webp']);
    expect(r.html).toBe('<img src=img/a.webp>');
  });

  it('stem 衝突 (a.png と a.webp が両方 server) は曖昧として rewrite しない', () => {
    const html = '<img src="images/a.gif">';
    const r = rewriteHtmlToServerAssets(html, ['a.png', 'a.webp']);
    expect(r.html).toBe(html);
    expect(r.unmatched).toEqual(['images/a.gif']);
  });

  it('exact filename 一致は stem より優先 (no-op)', () => {
    const html = '<img src="img/concept-01.webp">';
    const r = rewriteHtmlToServerAssets(html, ['concept-01.webp']);
    expect(r.html).toBe(html);
    expect(r.rewritten).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });

  it('サーバに無い参照は unmatched で元参照のまま返す', () => {
    const html = '<img src="img/ghost.png">';
    const r = rewriteHtmlToServerAssets(html, ['concept-01.webp']);
    expect(r.html).toBe(html);
    expect(r.unmatched).toEqual(['img/ghost.png']);
  });

  it('./images/ プレフィックスも揃える', () => {
    const html = '<img src="./images/a.png">';
    const r = rewriteHtmlToServerAssets(html, ['a.webp']);
    expect(r.html).toBe('<img src="img/a.webp">');
  });
});
