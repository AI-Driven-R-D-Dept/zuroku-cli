// `zuroku update` の registerUpdateCommand を Command に登録し、option とシグネチャを
// 検証する。keep-assets の HTML rewrite ロジックは publish.test.ts の
// rewriteHtmlToServerAssets で、--title の事前 validation は実装の単純な
// trim/length チェックでカバーされる。

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerUpdateCommand } from '../src/commands/update.js';

function makeProgram(): Command {
  const program = new Command();
  program.name('zuroku').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerUpdateCommand(program);
  return program;
}

describe('registerUpdateCommand', () => {
  it('update に keep-assets / title / base-url / no-compress option が登録されている', () => {
    const program = makeProgram();
    const update = program.commands.find((c) => c.name() === 'update')!;
    const optNames = update.options.map((o) => o.long);
    expect(optNames).toContain('--keep-assets');
    expect(optNames).toContain('--title');
    expect(optNames).toContain('--base-url');
    expect(optNames).toContain('--no-compress');
  });

  it('--title は短縮 -T を持つ', () => {
    const program = makeProgram();
    const update = program.commands.find((c) => c.name() === 'update')!;
    const title = update.options.find((o) => o.long === '--title')!;
    expect(title.short).toBe('-T');
  });

  it('update の必須引数シグネチャ (slug-or-id, html, [images...])', () => {
    const program = makeProgram();
    const update = program.commands.find((c) => c.name() === 'update')!;
    const args = update.registeredArguments.map((a) => a.name());
    expect(args).toEqual(['slug-or-id', 'html', 'images']);
  });
});
