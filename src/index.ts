import { Command } from 'commander';
import { registerLoginCommand } from './commands/login.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerListCommand } from './commands/list.js';
import { registerDeleteCommand } from './commands/delete.js';
import { registerConfigCommand } from './commands/config.js';

// package.json version is read at build time. Hard-code the constant — keeping
// it in sync with package.json is part of the release checklist.
const VERSION = '0.1.0';

const program = new Command();

program
  .name('zuroku')
  .description('zuroku — AI-driven graphic-recording publish tool')
  .version(VERSION, '-v, --version', 'print version');

registerLoginCommand(program);
registerPublishCommand(program);
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
