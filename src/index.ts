import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerLoginCommand } from './commands/login.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerListCommand } from './commands/list.js';
import { registerDeleteCommand } from './commands/delete.js';
import { registerConfigCommand } from './commands/config.js';

// Version は package.json から起動時に読む (release checklist 漏れによる
// hardcode drift を構造的に防ぐ)。dist/cli.js から見て ../package.json。
function readPackageVersion(): string {
  const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

const VERSION = readPackageVersion();

const program = new Command();

program
  .name('zuroku')
  .description('zuroku — AI-driven graphic-recording publish tool')
  .version(VERSION, '-v, --version', 'print version');

registerLoginCommand(program);
registerPublishCommand(program);
registerUpdateCommand(program);
registerListCommand(program);
registerDeleteCommand(program);
registerConfigCommand(program);

program.showHelpAfterError();
program.parseAsync(process.argv).catch((e: unknown) => {
  // commander itself swallows handler errors via .action; this catches the
  // synchronous parse-failure path. fatal() exits with 1.
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
