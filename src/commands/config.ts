import { Command } from 'commander';
import {
  getConfigPath,
  loadConfig,
  saveConfig,
  ZurokuError,
  type DefaultVisibility,
  type ZurokuConfig,
} from '@zuroku/core';
import { fatal, info, success } from '../lib/console.js';

type ConfigKey = 'default-visibility';

const KEYS: readonly ConfigKey[] = ['default-visibility'] as const;

function parseKey(raw: string): ConfigKey {
  if ((KEYS as readonly string[]).includes(raw)) return raw as ConfigKey;
  throw new ZurokuError(
    'INVALID_INPUT',
    0,
    `unknown config key '${raw}'. valid keys: ${KEYS.join(', ')}`,
  );
}

export function parseVisibility(raw: string): DefaultVisibility {
  if (raw === 'private' || raw === 'curator') return raw;
  if (raw === 'public') {
    // 'public' は server 予約語で reject される。default 保存は許可しない
    // (うっかり default 公開化の事故防止)。
    throw new ZurokuError(
      'INVALID_INPUT',
      0,
      "'public' is reserved by the server and cannot be stored as default-visibility.",
    );
  }
  throw new ZurokuError(
    'INVALID_INPUT',
    0,
    `--default-visibility must be 'private' or 'curator' (got '${raw}')`,
  );
}

/**
 * config を読み込む。core の `loadConfig` は ENOENT を default 値で吸収するので
 * ここで投げてくる例外は "ファイルはあるが parse 不可" or "permission denied" だけ。
 * そのまま `fatal()` に渡し、malformed JSON を `set` で黙って上書きしないようにする
 * (data loss 防止)。
 */
async function readConfigOrFatal(): Promise<ZurokuConfig> {
  try {
    return await loadConfig();
  } catch (e) {
    throw new ZurokuError(
      'CONFIG',
      0,
      `Failed to read config (refusing to overwrite a corrupt file): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function registerConfigCommand(parent: Command): void {
  const config = parent
    .command('config')
    .description('Manage local CLI config (~/.config/zuroku/config.json)');

  config
    .command('get')
    .description('Print one config key, or all keys when no key is given')
    .argument('[key]', `Config key (${KEYS.join(' | ')})`)
    .action(async (rawKey: string | undefined) => {
      try {
        const cfg = await readConfigOrFatal();
        if (rawKey === undefined) {
          info(`path: ${getConfigPath()}`);
          process.stdout.write(`default-visibility=${cfg.default_visibility ?? '(unset, server default: curator)'}\n`);
          return;
        }
        const key = parseKey(rawKey);
        if (key === 'default-visibility') {
          process.stdout.write(`${cfg.default_visibility ?? ''}\n`);
        }
      } catch (e) {
        fatal(e);
      }
    });

  config
    .command('set')
    .description('Set a config key')
    .argument('<key>', `Config key (${KEYS.join(' | ')})`)
    .argument('<value>', "Value (for default-visibility: 'private' | 'curator')")
    .action(async (rawKey: string, rawValue: string) => {
      try {
        const key = parseKey(rawKey);
        const existing = await readConfigOrFatal();
        if (key === 'default-visibility') {
          const v = parseVisibility(rawValue);
          const next: ZurokuConfig = { ...existing, default_visibility: v };
          await saveConfig(next);
          success(`default-visibility = ${v}`);
          info(`config: ${getConfigPath()}`);
        }
      } catch (e) {
        fatal(e);
      }
    });

  config
    .command('unset')
    .description('Remove a config key (revert to server default)')
    .argument('<key>', `Config key (${KEYS.join(' | ')})`)
    .action(async (rawKey: string) => {
      try {
        const key = parseKey(rawKey);
        const existing = await readConfigOrFatal();
        if (key === 'default-visibility') {
          const next: ZurokuConfig = { ...existing };
          delete next.default_visibility;
          await saveConfig(next);
          success('default-visibility cleared (server default: curator)');
        }
      } catch (e) {
        fatal(e);
      }
    });
}
