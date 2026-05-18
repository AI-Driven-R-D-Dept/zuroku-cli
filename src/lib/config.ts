import { loadConfig as loadCoreConfig, ZurokuClient, ZurokuError } from '@zuroku/core';
import type { ZurokuConfig } from '@zuroku/core';

export interface RuntimeConfigOpts {
  /** Override base URL (e.g. from --base-url). */
  baseUrl?: string;
  /** When true, skip the empty-token guard (used by `auth login`). */
  allowMissingToken?: boolean;
}

/**
 * Load `~/.config/zuroku/config.json`, optionally overlaying CLI-supplied
 * `--base-url`. Throws `ZurokuError('CONFIG')` when the token is missing
 * (unless `allowMissingToken` is set), so the caller's `fatal()` can render
 * the standard `auth login` hint.
 */
export async function loadRuntimeConfig(
  opts: RuntimeConfigOpts = {},
): Promise<ZurokuConfig> {
  let config: ZurokuConfig;
  try {
    config = await loadCoreConfig();
  } catch (e) {
    throw new ZurokuError(
      'CONFIG',
      0,
      `Failed to read config: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (opts.baseUrl && opts.baseUrl.length > 0) {
    config = { ...config, base_url: opts.baseUrl };
  }

  if (!opts.allowMissingToken && config.token === '') {
    throw new ZurokuError(
      'CONFIG',
      0,
      'No API token configured. Run `zuroku auth login --token <key>` first.',
    );
  }

  return config;
}

/** Build a `ZurokuClient` from a fully-resolved runtime config. */
export function makeClient(config: ZurokuConfig): ZurokuClient {
  return new ZurokuClient({ baseUrl: config.base_url, token: config.token });
}
