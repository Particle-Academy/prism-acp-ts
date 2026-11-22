import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_SIGN_IN_HOSTS,
  ClaudeLoginError,
  claudeAccounts,
  claudeSignInUrl,
} from '../src/index.js';

/**
 * SIGN-IN AND SIGN-OUT WITH NO TERMINAL (Wish, 2026-11-22). The stand-in CLI reproduces what claude-code 2.1.330 was
 * measured doing on 2026-11-21 with no TTY: it hands the opener URL (localhost redirect) to $BROWSER, prints the
 * manual URL and `Paste code here if prompted > `, and reads a pasted code from stdin. Its "credential" is a marker
 * file it writes into its own config directory; the library must never open it.
 */

// Every (function, path) any fs function is handed while `watch.active`: the proof that the library opens nothing under
// the account directory. Wraps EVERY function export (and fs.promises), so a new call site cannot slip past a list.
const watch = vi.hoisted(() => ({ active: false, calls: [] as { fn: string; path: string }[] }));
const spy = vi.hoisted(() => function spyModule<T extends object>(actual: T, prefix = ''): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') {
      const record = (args: unknown[]) => {
        if (!watch.active) return;
        for (const arg of args.slice(0, 2)) {
          if (typeof arg === 'string') watch.calls.push({ fn: prefix + name, path: arg });
          else if (arg instanceof URL) watch.calls.push({ fn: prefix + name, path: arg.pathname });
        }
      };
      out[name] = new Proxy(value, {
        apply: (target, self, args) => { record(args); return Reflect.apply(target, self, args); },
        construct: (target, args, nt) => { record(args); return Reflect.construct(target, args, nt); },
      });
    } else if (name === 'promises' && typeof value === 'object' && value !== null) {
      out[name] = spyModule(value as object, 'promises.');
    } else {
      out[name] = value;
    }
  }
  return out as T;
});
vi.mock('node:fs', async () => {
  const wrapped = spy(await vi.importActual<typeof import('node:fs')>('node:fs'));
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async () => {
  const wrapped = spy(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), 'promises.');
  return { ...wrapped, default: wrapped };
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
const tmp = (prefix = 'prism-login-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
beforeEach(() => { watch.active = false; watch.calls = []; });

const SECRET = 'sk-ant-must-never-reach-the-child';
const AUTO_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback&scope=user%3Aprofile+user%3Ainference&code_challenge=x&code_challenge_method=S256&state=s';
const MANUAL_URL = 'https://claude.ai/oauth/authorize?opaque-manual-key=';
const RIGHT_CODE = 'the-right-code#the-state';

/**
 * The stand-in. argv: `<script> <mode> <stateDir> auth (login|logout|status) ...`. It appends one line per run to
 * `<stateDir>/runs.jsonl` (argv, env NAMES, CLAUDE_CONFIG_DIR -- never a value of anything else), starts a grandchild
 * that records its pid, and signs in by writing `fake-signed-in` into its config directory.
 */
function standIn(mode: 'auto' | 'code' | 'fallback' | 'hang' | 'evilPrinted' | 'evilOpener' | 'httpOpener') {
  const state = tmp('prism-login-cli-');
  const script = join(state, 'claude.mjs');
  writeFileSync(script, `
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const [mode, state, ...args] = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
appendFileSync(join(state, 'runs.jsonl'), JSON.stringify({ args, names: Object.keys(process.env), configDir: dir ?? null, hasBrowser: !!process.env.BROWSER }) + '\\n');
const marker = join(dir, 'fake-signed-in');
if (args[1] === 'status') {
  const signed = existsSync(marker);
  process.stdout.write(JSON.stringify(signed
    ? { loggedIn: true, authMethod: 'claude.ai', email: 'person@example.com', subscriptionType: 'max', configDirectory: dir }
    : { loggedIn: false, authMethod: 'none', configDirectory: dir }) + '\\n');
  process.exit(signed ? 0 : 1);
}
if (args[1] === 'logout') { rmSync(marker, { force: true }); console.log('Successfully logged out from your Anthropic account.'); process.exit(0); }
// login: what the real CLI leaves on first use, then a grandchild that only a tree kill ends.
writeFileSync(join(dir, '.claude.json'), '{}');
mkdirSync(join(dir, 'backups'), { recursive: true });
writeFileSync(join(dir, 'backups', '.claude.json.backup.1'), '{}');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(join(state, 'grandchild.pid'), String(grandchild.pid));
const open = (url) => {
  const b = process.env.BROWSER;
  if (!b) return;
  if (process.platform === 'win32') spawn('"' + b + '" "' + url + '"', { shell: true, stdio: 'ignore' });
  else spawn(b, [url], { stdio: 'ignore' });
};
const say = (t) => process.stdout.write(t);
const finish = () => { writeFileSync(marker, 'stand-in login'); process.exit(0); };
const readCode = () => createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(join(state, 'codes.txt'), line + '\\n');
  if (line.trim() === ${JSON.stringify(RIGHT_CODE)}) finish();
  process.stderr.write("Couldn't log in: That code wasn't accepted.\\n"); process.exit(1);
});
say('Opening browser to sign in\\u2026\\n');
if (mode === 'auto' || mode === 'fallback') open(${JSON.stringify(AUTO_URL)});
if (mode === 'evilOpener') open('https://claude.ai.evil.example/oauth/authorize?state=s');
if (mode === 'httpOpener') open('http://claude.ai/oauth/authorize?state=s');
setTimeout(() => {
  say("If the browser didn't open, visit:\\n" + (mode === 'evilPrinted' ? 'https://evil.example/oauth/authorize?state=s' : ${JSON.stringify(MANUAL_URL)}) + '\\nPaste code here if prompted > ');
  if (mode === 'auto') setInterval(() => { if (existsSync(join(state, 'browser-done'))) finish(); }, 50);
  if (mode === 'code') readCode();
  if (mode === 'fallback') setTimeout(() => { say("\\nThe browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\\nPaste code here > "); readCode(); }, 400);
  if (mode === 'hang' || mode === 'evilPrinted' || mode === 'evilOpener' || mode === 'httpOpener') setInterval(() => {}, 1000);
}, 200);
`);
  const runs = () => (existsSync(join(state, 'runs.jsonl')) ? readFileSync(join(state, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; names: string[]; configDir: string | null; hasBrowser: boolean }) : []);
  const grandchild = () => (existsSync(join(state, 'grandchild.pid')) ? Number(readFileSync(join(state, 'grandchild.pid'), 'utf8')) : null);
  const browserDone = () => writeFileSync(join(state, 'browser-done'), '');
  const codes = () => (existsSync(join(state, 'codes.txt')) ? readFileSync(join(state, 'codes.txt'), 'utf8') : '');
  return { cli: { binary: process.execPath, binaryArgs: [script, mode, state] }, runs, grandchild, browserDone, codes };
}

function alive(pid: number | null): boolean {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until<T>(what: string, read: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const hostile = () => ({ ...process.env, ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET, BROWSER: 'host-browser-must-not-leak' });
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ClaudeLoginError; } throw new Error('expected a rejection'); };

describe('the sign-in URL allow-list', () => {
  it('accepts https on the exact Anthropic and Claude hosts only', () => {
    for (const host of CLAUDE_SIGN_IN_HOSTS) expect(claudeSignInUrl(`https://${host}/oauth/authorize?x=1`)).not.toBeNull();
    expect(claudeSignInUrl(AUTO_URL)).toBe(AUTO_URL);
    for (const bad of [
      'http://claude.ai/oauth', 'https://claude.ai.evil.example/oauth', 'https://evil.example/claude.ai', 'https://evilclaude.ai/x',
      'https://user@claude.ai/x', 'https://claude.ai:444/x', 'javascript:alert(1)', 'file:///etc/passwd', 'https://claude.ai/x y',
      'https://claude.ai/x\n', 'https://sub.claude.ai/x', '', 'https://claude.ai/' + 'a'.repeat(9000),
    ]) expect(claudeSignInUrl(bad), bad).toBeNull();
  });
});

describe('claudeAccounts.login', { timeout: 30_000 }, () => {
  it('(a) hands out the opener URL (localhost redirect), waits for the CLI, and confirms signed in', async () => {
    const fake = standIn('auto');
    const account = join(tmp(), 'work');
    const urls: string[] = [];
    let asked = 0;
    const status = await claudeAccounts.login(account, {
      ...fake.cli, parentEnv: hostile(),
      onUrl: (url) => { urls.push(url); fake.browserDone(); },
      onCodeRequested: async () => { asked++; return 'never'; },
    });
    expect(urls).toEqual([AUTO_URL]);
    expect(asked).toBe(0);
    expect(status.signedIn).toBe(true);
    expect(status.requestedConfigDir).toBe(resolve(account));
    const login = fake.runs().find((r) => r.args[1] === 'login')!;
    expect(login.args).toEqual(['auth', 'login', '--claudeai']);
    expect(login.configDir).toBe(resolve(account));
    expect(login.hasBrowser).toBe(true);
    // The same cleaned environment as a launch: no credential reached the CLI.
    for (const run of fake.runs()) for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) expect(run.names).not.toContain(name);
    // A success leaves what the CLI wrote.
    expect(existsSync(join(account, 'fake-signed-in'))).toBe(true);
    expect(alive(fake.grandchild())).toBe(false);
  });

  it('(b) asks for the code when only the printed URL is offered, and writes it to the CLI\'s stdin', async () => {
    const fake = standIn('code');
    const account = join(tmp(), 'work');
    const urls: string[] = [];
    const status = await claudeAccounts.login(account, {
      ...fake.cli, method: 'console',
      onUrl: (url) => { urls.push(url); },
      onCodeRequested: async () => `  ${RIGHT_CODE}  `,
    });
    expect(urls).toEqual([MANUAL_URL]);
    expect(status.signedIn).toBe(true);
    expect(fake.runs().find((r) => r.args[1] === 'login')!.args).toEqual(['auth', 'login', '--console']);
    expect(fake.codes()).toBe(`${RIGHT_CODE}\n`);
  });

  it('(b) asks for the code when the CLI says the browser could not return the sign-in', async () => {
    const fake = standIn('fallback');
    const account = join(tmp(), 'work');
    const urls: string[] = [];
    const status = await claudeAccounts.login(account, { ...fake.cli, onUrl: (u) => { urls.push(u); }, onCodeRequested: async () => RIGHT_CODE });
    expect(urls).toEqual([AUTO_URL]);
    expect(status.signedIn).toBe(true);
  });

  it('(b) without onCodeRequested a code-only flow is refused, and the tree is killed', async () => {
    const fake = standIn('code');
    const account = join(tmp(), 'work');
    const error = await failure(claudeAccounts.login(account, { ...fake.cli, onUrl: () => {} }));
    expect(error).toBeInstanceOf(ClaudeLoginError);
    expect(error.code).toBe('codeRequired');
    expect(alive(fake.grandchild())).toBe(false);
    expect(existsSync(account)).toBe(false);
  });

  it('a wrong code fails, and the half-made directory is removed', async () => {
    const fake = standIn('code');
    const account = join(tmp(), 'work');
    const error = await failure(claudeAccounts.login(account, { ...fake.cli, onUrl: () => {}, onCodeRequested: async () => 'wrong' }));
    expect(error.code).toBe('failed');
    expect(error.message).not.toContain('wrong');
    expect(existsSync(account)).toBe(false);
  });

  it('refuses a code that is not one line of printable text', async () => {
    const fake = standIn('code');
    const error = await failure(claudeAccounts.login(join(tmp(), 'work'), { ...fake.cli, onUrl: () => {}, onCodeRequested: async () => 'a\nb' }));
    expect(error.code).toBe('invalidCode');
    expect(fake.codes()).toBe('');
  });

  it('(c) times out, kills the whole tree, and removes the directory it created', async () => {
    const fake = standIn('hang');
    const account = join(tmp(), 'work');
    const error = await failure(claudeAccounts.login(account, { ...fake.cli, timeoutMs: 1_500, onUrl: () => {}, onCodeRequested: () => new Promise(() => {}) }));
    expect(error.code).toBe('timeout');
    const pid = fake.grandchild();
    expect(pid).not.toBeNull();
    expect(alive(pid)).toBe(false);
    expect(existsSync(account)).toBe(false);
  });

  it('(d) refuses a non-Anthropic URL, printed or handed to the opener, and never hands it out', async () => {
    for (const mode of ['evilPrinted', 'evilOpener', 'httpOpener'] as const) {
      const fake = standIn(mode);
      const account = join(tmp(), 'work');
      const urls: string[] = [];
      const error = await failure(claudeAccounts.login(account, { ...fake.cli, onUrl: (u) => { urls.push(u); }, onCodeRequested: async () => 'x' }));
      expect(error.code, mode).toBe('refusedUrl');
      expect(urls, mode).toEqual([]);
      expect(alive(fake.grandchild()), mode).toBe(false);
      expect(existsSync(account), mode).toBe(false);
    }
  });

  it('abort kills the whole tree; in a directory that already existed only what this call added is removed', async () => {
    const fake = standIn('hang');
    const account = tmp('prism-login-existing-');
    mkdirSync(join(account, 'projects'));
    writeFileSync(join(account, 'settings.json'), '{}');
    const controller = new AbortController();
    const pending = failure(claudeAccounts.login(account, {
      ...fake.cli, signal: controller.signal,
      onUrl: () => {}, onCodeRequested: () => new Promise(() => {}),
    }));
    await until('the grandchild', () => (alive(fake.grandchild()) ? true : undefined));
    await until('the CLI\'s files', () => (existsSync(join(account, '.claude.json')) ? true : undefined));
    controller.abort();
    const error = await pending;
    expect(error.code).toBe('aborted');
    expect(alive(fake.grandchild())).toBe(false);
    expect(readdirSync(account).sort()).toEqual(['projects', 'settings.json']);
  });

  it('refuses the default account and a relative path before running anything', async () => {
    const fake = standIn('auto');
    for (const dir of [null, join(homedir(), '.claude'), join(homedir(), '.claude') + sep]) {
      const error = await failure(claudeAccounts.login(dir as string, { ...fake.cli, onUrl: () => {} }));
      expect(error.code).toBe('refusedDirectory');
      const out = await failure(claudeAccounts.logout(dir as string, fake.cli));
      expect(out.code).toBe('refusedDirectory');
    }
    await expect(claudeAccounts.login('relative', { ...fake.cli, onUrl: () => {} })).rejects.toThrow(/absolute/);
    expect(fake.runs()).toEqual([]);
  });

  it('an already-aborted signal runs nothing', async () => {
    const fake = standIn('auto');
    const controller = new AbortController();
    controller.abort();
    const error = await failure(claudeAccounts.login(join(tmp(), 'w'), { ...fake.cli, signal: controller.signal, onUrl: () => {} }));
    expect(error.code).toBe('aborted');
    expect(fake.runs()).toEqual([]);
  });
});

describe('claudeAccounts.logout', { timeout: 30_000 }, () => {
  it('runs the CLI\'s own logout in that directory and confirms signed out', async () => {
    const fake = standIn('auto');
    const account = join(tmp(), 'work');
    await claudeAccounts.login(account, { ...fake.cli, onUrl: () => fake.browserDone() });
    const status = await claudeAccounts.logout(account, { ...fake.cli, parentEnv: hostile() });
    expect(status.signedIn).toBe(false);
    const run = fake.runs().find((r) => r.args[1] === 'logout')!;
    expect(run.args).toEqual(['auth', 'logout']);
    expect(run.configDir).toBe(resolve(account));
    expect(run.names).not.toContain('ANTHROPIC_API_KEY');
    expect(run.hasBrowser).toBe(false);
    expect(existsSync(account)).toBe(true);
  });

  it('refuses a directory that does not exist', async () => {
    const fake = standIn('auto');
    const error = await failure(claudeAccounts.logout(join(tmp(), 'missing'), fake.cli));
    expect(error.code).toBe('missingDirectory');
    expect(fake.runs()).toEqual([]);
  });
});

describe('the library never reads a file under the account directory', { timeout: 30_000 }, () => {
  it('login and logout only create, list and remove there -- and never touch the credential file at all', async () => {
    const fake = standIn('auto');
    const account = tmp('prism-login-watched-');
    // Something a careless implementation might read, sitting where Claude Code keeps it.
    writeFileSync(join(account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
    watch.active = true;
    try {
      await claudeAccounts.login(account, { ...fake.cli, onUrl: () => fake.browserDone() });
      await claudeAccounts.logout(account, fake.cli);
      // And a failed one, which cleans up.
      await failure(claudeAccounts.login(account, { ...standIn('evilPrinted').cli, onUrl: () => {} }));
    } finally {
      watch.active = false;
    }
    expect(watch.calls.length).toBeGreaterThan(0);
    const root = resolve(account).toLowerCase();
    const inside = watch.calls.filter(({ path }) => { const r = resolve(path).toLowerCase(); return r === root || r.startsWith(root + sep); });
    // The spy saw the directory itself, so an empty list below is not a broken spy.
    expect(inside.length).toBeGreaterThan(0);
    const allowed = new Set(['lstatSync', 'readdirSync', 'rmSync', 'existsSync', 'statSync', 'mkdirSync']);
    expect(inside.filter(({ fn }) => !allowed.has(fn))).toEqual([]);
    expect(inside.filter(({ path }) => path.toLowerCase().includes('.credentials'))).toEqual([]);
    expect(readFileSync(join(account, '.credentials.json'), 'utf8')).toContain(SECRET);
  });
});
