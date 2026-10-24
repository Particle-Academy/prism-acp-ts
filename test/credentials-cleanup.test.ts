import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const restrict = vi.hoisted(() => ({ fail: true }));
vi.mock('../src/private-directory.js', () => ({
  restrictToCurrentUser: () => {
    if (restrict.fail) throw new Error('ACL refused');
  },
}));

const { apiKeyHome } = await import('../src/credentials.js');

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'prism-acp-cleanup-')); restrict.fail = true; });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

it('removes a home it created but could not make private, so a retry cannot accept it unrestricted', () => {
  const home = join(scratch, 'tenant');
  const credentials = { mode: 'apiKey' as const, apiKey: 'sk-fixture-only', home };

  expect(() => apiKeyHome('claude', credentials, {})).toThrow('credentials.home could not be created as a private directory');
  expect(existsSync(home)).toBe(false);

  // The retry creates and restricts it again, rather than accepting a leftover as the app's own.
  restrict.fail = false;
  expect(apiKeyHome('claude', credentials, {}).home).toBe(home);
  expect(existsSync(home)).toBe(true);
});
