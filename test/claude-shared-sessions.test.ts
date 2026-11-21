import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAccountError, ClaudeSharedSessionsError, claudeAccounts, defaultClaudeSessionStore, prepareClaudeAccount } from '../src/index.js';

/**
 * SHARED SESSIONS (G-318, Wish 2026-11-21): `prepare(configDir, { sharedSessions: true, store })` makes
 * `<configDir>/projects` a link to the store -- a junction on Windows, a directory symlink elsewhere -- and nothing
 * else. It refuses, changing nothing, when something else is already there.
 *
 * Every `node:fs` call made while `watch.active` is recorded by NAME with its path arguments, so a test can prove that
 * prepare opened no file, listed no directory, and created nothing but the directory and its one link. The wrapper
 * covers every function export, so a new call site cannot slip past a list.
 */
const watch = vi.hoisted(() => ({ active: false, calls: [] as { name: string; paths: string[] }[] }));
const wrap = vi.hoisted(() => function wrapModule<T extends object>(actual: T, prefix = ''): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') {
      const record = (args: unknown[]) => {
        if (!watch.active) return;
        const paths = args.slice(0, 2).flatMap((a) => (typeof a === 'string' ? [a] : a instanceof URL ? [a.pathname] : Buffer.isBuffer(a) ? [a.toString()] : []));
        watch.calls.push({ name: prefix + name, paths });
      };
      out[name] = new Proxy(value, {
        apply: (target, self, args) => { record(args); return Reflect.apply(target, self, args); },
        construct: (target, args, nt) => { record(args); return Reflect.construct(target, args, nt); },
      });
    } else if (name === 'promises' && typeof value === 'object' && value !== null) {
      out[name] = wrapModule(value as object, 'promises.');
    } else {
      out[name] = value;
    }
  }
  return out as T;
});
vi.mock('node:fs', async () => {
  const wrapped = wrap(await vi.importActual<typeof import('node:fs')>('node:fs'));
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async () => {
  const wrapped = wrap(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), 'promises.');
  return { ...wrapped, default: wrapped };
});

const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
beforeEach(() => { watch.active = false; watch.calls = []; });

/** A fresh temp root holding a store (with one transcript in it) and room for account directories. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'prism-g318-'));
  roots.push(root);
  const store = join(root, 'store');
  mkdirSync(join(store, '-slug'), { recursive: true });
  writeFileSync(join(store, '-slug', 'thread.jsonl'), '{}\n');
  return { root, store, account: (name: string) => join(root, name) };
}

/** Run prepare with the fs watch on; return what it called. */
function watched<T>(run: () => T): { result?: T; error?: unknown; calls: { name: string; paths: string[] }[] } {
  watch.calls = [];
  watch.active = true;
  try { return { result: run(), calls: watch.calls }; } catch (error) { return { error, calls: watch.calls }; } finally { watch.active = false; }
}

/** Reads of content, listings, writes and removals: none of these may appear, whatever the outcome. */
const FORBIDDEN = /^(promises\.)?(read(?!link|lpath)|open|createReadStream|createWriteStream|write|append|copy|cp|rename|rm|unlink|truncate|ftruncate|watch|exists)/i;
const CREATING = new Set(['mkdirSync', 'symlinkSync', 'mkdir', 'symlink', 'promises.mkdir', 'promises.symlink', 'linkSync', 'link', 'mkdtempSync', 'mkdtemp']);

function assertQuiet(calls: { name: string; paths: string[] }[], dir: string, allowedCreations: string[]) {
  for (const call of calls) {
    expect(call.name, `fs.${call.name} must not be called`).not.toMatch(FORBIDDEN);
    if (CREATING.has(call.name)) {
      // symlinkSync(target, path): the created path is the second argument.
      const created = resolve(call.name.includes('symlink') || call.name.includes('link') ? call.paths[1]! : call.paths[0]!);
      expect(allowedCreations.map((p) => p.toLowerCase()), `fs.${call.name} created an unexpected path`).toContain(created.toLowerCase());
    }
    for (const p of call.paths) {
      const rel = relative(dir, resolve(p));
      // Nothing under the account directory is touched except the directory itself and its projects entry.
      if (rel !== '' && !rel.startsWith('..')) expect(rel.toLowerCase()).toBe('projects');
    }
  }
}

function isJunction(link: string): boolean {
  const listing = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/c', 'dir', '/AL', resolve(link, '..')], { encoding: 'utf8', windowsHide: true });
  // `dir /AL` prints `<JUNCTION>` for a junction and `<SYMLINKD>` for a directory symlink.
  return listing.split(/\r?\n/).some((line) => line.includes('<JUNCTION>') && /\sprojects \[/.test(line));
}

describe('claudeAccounts.prepare -- shared sessions (G-318)', () => {
  it('is on the claudeAccounts object, and the default store is the CLI default directory\'s projects (pure)', () => {
    expect(claudeAccounts.prepare).toBe(prepareClaudeAccount);
    const { calls } = watched(() => defaultClaudeSessionStore());
    expect(defaultClaudeSessionStore()).toBe(join(homedir(), '.claude', 'projects'));
    expect(calls).toEqual([]);
  });

  it('creates the directory and the link, then reports it existing (idempotent)', () => {
    const w = world();
    const dir = w.account('A');
    const link = join(dir, 'projects');
    const first = watched(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store }));
    expect(first.error).toBeUndefined();
    expect(first.result).toEqual({ configDir: resolve(dir), sharedSessions: true, store: resolve(w.store), linked: 'created' });
    // The watch sees prepare's calls at all (so an empty list elsewhere means something).
    expect(first.calls.map((c) => c.name)).toEqual(expect.arrayContaining(['mkdirSync', 'symlinkSync', 'lstatSync']));
    assertQuiet(first.calls, dir, [dir, link]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // Through the link, the store's transcript is visible: the CLI would find it under this account.
    expect(statSync(join(link, '-slug', 'thread.jsonl')).isFile()).toBe(true);

    const second = watched(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store }));
    expect(second.result).toEqual({ configDir: resolve(dir), sharedSessions: true, store: resolve(w.store), linked: 'existing' });
    expect(second.calls.filter((c) => CREATING.has(c.name))).toEqual([]);
    assertQuiet(second.calls, dir, []);
  });

  it.runIf(process.platform === 'win32')('makes a directory junction on Windows', () => {
    const w = world();
    const dir = w.account('J');
    claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store });
    expect(isJunction(join(dir, 'projects'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('makes a directory symlink on POSIX, pointing at the store', () => {
    const w = world();
    const dir = w.account('S');
    claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store });
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(join(dir, 'projects')))).toBe(resolve(w.store));
  });

  it('creates a missing directory private to this user', () => {
    const w = world();
    const dir = w.account('P');
    claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store });
    if (process.platform === 'win32') {
      const acl = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [dir], { encoding: 'utf8', windowsHide: true });
      // No inherited entry, and exactly one grant.
      expect(acl).not.toContain('(I)');
      expect(acl.split(/\r?\n/).filter((l) => l.includes(':(')).length).toBe(1);
    } else {
      expect(statSync(dir).mode & 0o077).toBe(0);
    }
  });

  it('REFUSES a real projects folder, and changes nothing', () => {
    const w = world();
    const dir = w.account('R');
    mkdirSync(join(dir, 'projects'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'own.jsonl'), 'mine\n');
    const run = watched(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store }));
    expect(run.error).toBeInstanceOf(ClaudeSharedSessionsError);
    expect(run.error).toBeInstanceOf(ClaudeAccountError);
    expect((run.error as ClaudeSharedSessionsError).code).toBe('realFolder');
    expect((run.error as Error).message).not.toContain(w.root);
    expect(run.calls.filter((c) => CREATING.has(c.name))).toEqual([]);
    assertQuiet(run.calls, dir, []);
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dir, 'projects', 'own.jsonl'))).toBe(true);
  });

  it('REFUSES a link to somewhere else, and a dangling link, and changes neither', () => {
    const w = world();
    const elsewhere = join(w.root, 'elsewhere');
    mkdirSync(elsewhere);
    const dir = w.account('W');
    mkdirSync(dir);
    symlinkSync(elsewhere, join(dir, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    const run = watched(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store }));
    expect((run.error as ClaudeSharedSessionsError).code).toBe('linkedElsewhere');
    expect(run.calls.filter((c) => CREATING.has(c.name))).toEqual([]);
    assertQuiet(run.calls, dir, []);
    expect(realpathSync(join(dir, 'projects')).toLowerCase()).toBe(realpathSync(elsewhere).toLowerCase());

    const gone = join(w.root, 'gone');
    mkdirSync(gone);
    const dangling = w.account('D');
    mkdirSync(dangling);
    symlinkSync(gone, join(dangling, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    rmSync(gone, { recursive: true });
    const second = watched(() => claudeAccounts.prepare(dangling, { sharedSessions: true, store: w.store }));
    expect((second.error as ClaudeSharedSessionsError).code).toBe('linkedElsewhere');
    expect(lstatSync(join(dangling, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('REFUSES a file at projects', () => {
    const w = world();
    const dir = w.account('F');
    mkdirSync(dir);
    writeFileSync(join(dir, 'projects'), '');
    const run = watched(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store }));
    expect((run.error as ClaudeSharedSessionsError).code).toBe('occupied');
    expect(statSync(join(dir, 'projects')).isFile()).toBe(true);
  });

  it('without sharedSessions: creates only the directory, and REFUSES a directory that is linked anyway', () => {
    const w = world();
    const dir = w.account('N');
    const plain = watched(() => claudeAccounts.prepare(dir));
    expect(plain.result).toEqual({ configDir: resolve(dir), sharedSessions: false, store: null, linked: null });
    assertQuiet(plain.calls, dir, [dir]);
    expect(existsSync(join(dir, 'projects'))).toBe(false);

    claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store });
    const linked = watched(() => claudeAccounts.prepare(dir, { sharedSessions: false }));
    expect((linked.error as ClaudeSharedSessionsError).code).toBe('unexpectedLink');
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('REFUSES a missing store, a relative store and a store inside the link, before creating anything', () => {
    const w = world();
    const dir = w.account('X');
    const missing = watched(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: join(w.root, 'no-store') }));
    expect((missing.error as ClaudeSharedSessionsError).code).toBe('storeMissing');
    expect(missing.calls.filter((c) => CREATING.has(c.name))).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(w.root, 'no-store'))).toBe(false);
    expect(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: 'relative/store' })).toThrow(expect.objectContaining({ code: 'storeInvalid' }));
    expect(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: join(dir, 'projects') })).toThrow(expect.objectContaining({ code: 'storeInvalid' }));
    expect(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: join(dir, 'projects', 'x') })).toThrow(expect.objectContaining({ code: 'storeInvalid' }));
    expect(existsSync(dir)).toBe(false);
  });

  it('REFUSES a missing parent, a file as the directory, and the CLI default directory (without touching it)', () => {
    const w = world();
    expect(() => claudeAccounts.prepare(join(w.root, 'no-parent', 'A'), { sharedSessions: true, store: w.store }))
      .toThrow(expect.objectContaining({ code: 'configDirInvalid' }));
    expect(existsSync(join(w.root, 'no-parent'))).toBe(false);
    writeFileSync(join(w.root, 'file'), '');
    expect(() => claudeAccounts.prepare(join(w.root, 'file'), { sharedSessions: true, store: w.store }))
      .toThrow(expect.objectContaining({ code: 'configDirInvalid' }));
    // A pure path comparison: the real default directory is never stat'ed, created or linked.
    const real = watched(() => claudeAccounts.prepare(join(homedir(), '.claude'), { sharedSessions: true, store: w.store }));
    expect((real.error as ClaudeSharedSessionsError).code).toBe('configDirInvalid');
    expect(real.calls).toEqual([]);
    expect(() => claudeAccounts.prepare(null as unknown as string)).toThrow(expect.objectContaining({ code: 'configDirInvalid' }));
    expect(() => claudeAccounts.prepare('relative/dir')).toThrow(ClaudeAccountError);
  });

  it('leaves everything else in the directory alone', () => {
    const w = world();
    const dir = w.account('E');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    for (const name of ['.claude.json', '.credentials.json', 'settings.json']) writeFileSync(join(dir, name), 'x');
    const run = watched(() => claudeAccounts.prepare(dir, { sharedSessions: true, store: w.store }));
    expect(run.result?.linked).toBe('created');
    assertQuiet(run.calls, dir, [join(dir, 'projects')]);
    expect(lstatSync(join(dir, 'sessions')).isSymbolicLink()).toBe(false);
    expect(run.calls.flatMap((c) => c.paths).some((p) => /credentials|\.claude\.json|sessions|settings/i.test(p))).toBe(false);
  });
});
