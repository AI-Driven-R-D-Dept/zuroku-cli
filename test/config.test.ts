import { Command } from 'commander';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getConfigPath, loadConfig, saveConfig, ZurokuError } from '@zuroku/core';
import { parseVisibility, registerConfigCommand } from '../src/commands/config.js';

const OLD_XDG = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (OLD_XDG === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = OLD_XDG;
  }
});

describe('config persistence', () => {
  it('uses ~/.config/zuroku/config.json when XDG_CONFIG_HOME is not set', () => {
    delete process.env.XDG_CONFIG_HOME;

    const configPath = getConfigPath();

    expect(configPath.endsWith(path.join('.config', 'zuroku', 'config.json'))).toBe(true);
  });

  it('loads defaults, saves config, and chmods file 0600', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zuroku-cli-'));
    process.env.XDG_CONFIG_HOME = dir;
    try {
      await expect(loadConfig()).resolves.toEqual({
        base_url: 'https://app.zuroku.masao.ai',
        token: '',
      });

      await saveConfig({ base_url: 'https://app.test', token: 'zrk_live_token' });

      await expect(loadConfig()).resolves.toEqual({
        base_url: 'https://app.test',
        token: 'zrk_live_token',
      });
      const mode = (await stat(getConfigPath())).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- `zuroku config` サブコマンド ----------------------------------------

function makeConfigProgram(): Command {
  const program = new Command();
  program.name('zuroku').exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerConfigCommand(program);
  return program;
}

describe('registerConfigCommand', () => {
  it('config / get / set / unset サブコマンドが登録される', () => {
    const program = makeConfigProgram();
    const config = program.commands.find((c) => c.name() === 'config');
    expect(config).toBeDefined();
    const subs = config!.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['get', 'set', 'unset']);
  });

  it('config set default-visibility private が round-trip する', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zuroku-cli-cfg-'));
    process.env.XDG_CONFIG_HOME = dir;
    try {
      const program = makeConfigProgram();
      // fatal() は process.exit を呼ぶので、bad path に入らない前提でテスト
      await program.parseAsync(['node', 'zuroku', 'config', 'set', 'default-visibility', 'private']);
      const loaded = await loadConfig();
      expect(loaded.default_visibility).toBe('private');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('config unset default-visibility で key が消える (生 JSON でも消えている)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zuroku-cli-cfg-'));
    process.env.XDG_CONFIG_HOME = dir;
    try {
      await saveConfig({
        base_url: 'https://app.test',
        token: 'zrk_live_token',
        default_visibility: 'curator',
      });
      const program = makeConfigProgram();
      await program.parseAsync(['node', 'zuroku', 'config', 'unset', 'default-visibility']);

      const loaded = await loadConfig();
      expect(loaded.default_visibility).toBeUndefined();

      // 生 JSON を読んで、ignore ではなく "key 自体が消えている" ことを確認
      // (loadConfig は不正値も undefined にするので、loaded だけ見ても区別がつかない)
      const raw = JSON.parse(await readFile(getConfigPath(), 'utf8'));
      expect('default_visibility' in raw).toBe(false);
      // 他の field は残っている
      expect(raw.base_url).toBe('https://app.test');
      expect(raw.token).toBe('zrk_live_token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- parseVisibility unit-test (S2) --------------------------------------

describe('parseVisibility', () => {
  it("'private' を accept する", () => {
    expect(parseVisibility('private')).toBe('private');
  });

  it("'curator' を accept する", () => {
    expect(parseVisibility('curator')).toBe('curator');
  });

  // 'public' は server 予約語、default-visibility への保存も reject する。
  it("'public' is rejected for default-visibility (accidental publish guard)", () => {
    expect(() => parseVisibility('public')).toThrow(ZurokuError);
    expect(() => parseVisibility('public')).toThrow(/reserved by the server/);
  });

  it.each(['Public', 'PRIVATE', 'foo', '', 'unlisted'])(
    '不正値 (%s) は INVALID_INPUT で throw',
    (bad) => {
      let raised: unknown = null;
      try {
        parseVisibility(bad);
      } catch (e) {
        raised = e;
      }
      expect(raised).toBeInstanceOf(ZurokuError);
      expect((raised as ZurokuError).code).toBe('INVALID_INPUT');
    },
  );
});
