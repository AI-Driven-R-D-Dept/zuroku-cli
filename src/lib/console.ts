import kleur from 'kleur';
import { ZurokuError } from '@zuroku/core';

/**
 * Console helpers — all human-readable progress goes to stderr, leaving
 * stdout reserved for machine-readable output (e.g. the final URL printed by
 * `publish`, or the table from `list`).
 */

export function info(msg: string): void {
  process.stderr.write(`${kleur.cyan('info')}  ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${kleur.yellow('warn')}  ${msg}\n`);
}

export function success(msg: string): void {
  process.stderr.write(`${kleur.green('ok')}    ${msg}\n`);
}

/**
 * Print an error message and exit with code 1.
 *
 * Recognises `ZurokuError` and prefixes the machine-readable code so users
 * can grep / script against it. Suggests `zuroku auth login` for auth errors.
 */
export function fatal(err: unknown): never {
  if (err instanceof ZurokuError) {
    const code = kleur.red().bold(err.code);
    const status = err.status > 0 ? kleur.dim(` [HTTP ${err.status}]`) : '';
    process.stderr.write(`${kleur.red('error')} ${code}${status} ${err.message}\n`);

    if (
      err.code === 'CONFIG' ||
      err.code === 'UNAUTHORIZED' ||
      err.code === 'AUTH' ||
      err.status === 401 ||
      err.status === 403
    ) {
      process.stderr.write(
        kleur.dim(
          '       hint: run `zuroku auth login --token <key>` to set credentials\n',
        ),
      );
    }
  } else if (err instanceof Error) {
    process.stderr.write(`${kleur.red('error')} ${err.message}\n`);
  } else {
    process.stderr.write(`${kleur.red('error')} ${String(err)}\n`);
  }
  process.exit(1);
}

/** Mask a secret token for display (`sk_live_abcd...wxyz`). */
export function maskToken(token: string): string {
  if (token.length <= 8) return '*'.repeat(token.length);
  const head = token.slice(0, 6);
  const tail = token.slice(-4);
  return `${head}...${tail}`;
}
