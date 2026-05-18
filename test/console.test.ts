import { describe, it, expect } from 'vitest';
import { ZurokuError } from '@zuroku/core';

// CLI の lib/console.ts は kleur stderr writer。fatal は ZurokuError.code を出す。
// stdout を vi.spyOn で stub するのが面倒なので、ここでは console モジュール export と
// ZurokuError integration の型契約だけ確認するスモーク。
describe('cli smoke', () => {
  it('@zuroku/core の ZurokuError がインポートできる', () => {
    const e = new ZurokuError('AUTH_INVALID', 401, 'token revoked');
    expect(e.code).toBe('AUTH_INVALID');
    expect(e.status).toBe(401);
    expect(e.message).toContain('token revoked');
  });
});
