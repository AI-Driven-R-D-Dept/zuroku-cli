import { Command } from 'commander';
import { loadConfig, saveConfig, DEFAULT_BASE_URL, getConfigPath } from '@zuroku/core';
import { fatal, info, maskToken, success } from '../lib/console.js';

interface LoginOpts {
  token: string;
  baseUrl?: string;
}

export function registerLoginCommand(parent: Command): void {
  const auth = parent.commands.find((c) => c.name() === 'auth') ?? parent.command('auth')
    .description('Authentication management');

  auth
    .command('login')
    .description('Save an API token to ~/.config/zuroku/config.json')
    .requiredOption('-t, --token <token>', 'API token (Bearer key)')
    .option('-u, --base-url <url>', 'Override API base URL', undefined)
    .action(async (opts: LoginOpts) => {
      try {
        const existing = await loadConfig().catch(() => ({
          base_url: DEFAULT_BASE_URL,
          token: '',
        }));

        const baseUrl =
          opts.baseUrl && opts.baseUrl.length > 0
            ? opts.baseUrl
            : existing.base_url || DEFAULT_BASE_URL;

        await saveConfig({ base_url: baseUrl, token: opts.token });

        info(`config: ${getConfigPath()}`);
        info(`base_url: ${baseUrl}`);
        info(`token: ${maskToken(opts.token)}`);
        success('credentials saved (mode 0600)');
      } catch (e) {
        fatal(e);
      }
    });
}
