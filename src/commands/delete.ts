import readline from 'node:readline';
import { Command } from 'commander';
import { fatal, info, success, warn } from '../lib/console.js';
import { loadRuntimeConfig, makeClient } from '../lib/config.js';

interface DeleteOpts {
  yes?: boolean;
  baseUrl?: string;
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(ok);
    };
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    rl.question(prompt, (ans) => {
      finish(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

export function registerDeleteCommand(parent: Command): void {
  parent
    .command('delete')
    .description('Delete a project by slug or id')
    .argument('<slug-or-id>', 'Project slug or id')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-u, --base-url <url>', 'Override API base URL')
    .action(async (target: string, opts: DeleteOpts) => {
      try {
        const config = await loadRuntimeConfig({ ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });

        if (!opts.yes) {
          const ok = await confirm(`delete project "${target}"? [y/N] `);
          if (!ok) {
            warn('cancelled');
            process.exit(0);
          }
        }

        const client = makeClient(config);
        info(`deleting ${target}...`);
        await client.delete(target);
        success(`deleted: ${target}`);
      } catch (e) {
        fatal(e);
      }
    });
}
