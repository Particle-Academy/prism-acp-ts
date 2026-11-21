import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeAccountError,
  ClaudeDriver,
  claudeAccountCheck,
  claudeAccountStatusOf,
  claudeAccounts,
  claudeLoginCommand,
  describeClaudeAccount,
  listModels,
  OUTRANKING_CREDENTIALS,
} from '../src/index.js';
import type { ClaudeAccountStatus } from '../src/index.js';

/**
 * CLAUDE ACCOUNT SELECTION (Wish, 2026-11-21). The library picks a configuration directory and asks the CLI what is
 * signed in there; it never reads, stores or passes a credential, and it never opens a file under the directory.
 *
 * The stand-in CLI answers `auth status --json` with the SHAPES measured from claude-code 2.1.330 on 2026-11-21
 * (identity values replaced), and reproduces the one precedence rule that matters here: an API key or OAuth token in
 * its environment wins over the directory's login. So a test that leaks a key into the child sees `api_key`, exactly
 * as the real CLI would report it.
 */

// Every path any fs function is handed while `watch.active`: the proof that the library opens nothing under the
// account directory. Wraps EVERY function export (and fs.promises), so a new call site cannot slip past a list.
const watch = vi.hoisted(() => ({ active: false, paths: [] as string[] }));
function spyModule<T extends object>(actual: T, record: (args: unknown[]) => void): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') {
      out[name] = new Proxy(value, {
        apply: (target, self, args) => { record(args); return Reflect.apply(target, self, args); },
        construct: (target, args, nt) => { record(args); return Reflect.construct(target, args, nt); },
      });
    } else if (name === 'promises' && typeof value === 'object' && value !== null) {
      out[name] = spyModule(value as object, record);
    } else {
      out[name] = value;
    }
  }
  return out as T;
}
const recordPaths = vi.hoisted(() => (args: unknown[]) => {
  if (!watch.active) return;
  for (const arg of args.slice(0, 2)) {
    if (typeof arg === 'string') watch.paths.push(arg);
    else if (arg instanceof URL) watch.paths.push(arg.pathname);
    else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(arg)) watch.paths.push(arg.toString());
  }
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const wrapped = spyModule(actual, recordPaths);
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const wrapped = spyModule(actual, recordPaths);
  return { ...wrapped, default: wrapped };
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
const tmp = (prefix = 'prism-accounts-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
beforeEach(() => { watch.active = false; watch.paths = []; });

const SECRET = 'sk-ant-must-never-reach-the-child';
const NOT_LOGGED_IN = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', loginExpiresAt: null };
const SUBSCRIPTION = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', loginExpiresAt: '2026-12-19T21:44:18.095Z',
  email: 'person@example.com', orgId: 'org-0000', orgName: 'Example', subscriptionType: 'max', storedClaudeAiLogin: true, planTier: 'max_20x',
};

/**
 * A Claude CLI stand-in. `statuses` maps a config directory (or 'default') to the status it holds. It logs, per run,
 * its argv, the NAMES of every variable it received, and CLAUDE_CONFIG_DIR's value -- never a credential value.
 */
function standIn(statuses: Record<string, Record<string, unknown>>) {
  const dir = tmp('prism-accounts-cli-');
  const script = join(dir, 'claude.mjs');
  const log = join(dir, 'runs.jsonl');
  const table = join(dir, 'statuses.json');
  writeFileSync(table, JSON.stringify(Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k === 'default' ? k : resolve(k).toLowerCase(), v]))));
  writeFileSync(script, `
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
const names = Object.keys(process.env);
const configDir = process.env.CLAUDE_CONFIG_DIR;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, names, configDir: configDir ?? null }) + '\\n');
if (args[0] === 'auth' && args[1] === 'status') {
  const table = JSON.parse(readFileSync(${JSON.stringify(table)}, 'utf8'));
  const key = configDir === undefined ? 'default' : resolve(configDir).toLowerCase();
  const reported = (configDir ?? resolve(homedir(), '.claude')).replace(/\\\\/g, '/');
  const has = (n) => names.some((x) => x.toUpperCase() === n);
  let status;
  // The measured precedence: an environment credential hides the directory's login entirely.
  if (has('ANTHROPIC_API_KEY')) status = { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY', loginExpiresAt: null };
  else if (has('CLAUDE_CODE_OAUTH_TOKEN') || has('ANTHROPIC_AUTH_TOKEN')) status = { loggedIn: true, authMethod: 'oauth_token', loginExpiresAt: null };
  else status = table[key] ?? ${JSON.stringify(NOT_LOGGED_IN)};
  process.stdout.write(JSON.stringify({ configDirectory: reported, ...status }, null, 2) + '\\n');
  process.exit(status.loggedIn ? 0 : 1);
}
// Anything else: a session. Stay alive until stdin closes.
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
  const runs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; names: string[]; configDir: string | null }) : []);
  return { binary: process.execPath, binaryArgs: [script], runs };
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

const hostile = () => ({
  ...process.env,
  ANTHROPIC_API_KEY: SECRET,
  anthropic_auth_token: SECRET,
  CLAUDE_CODE_OAUTH_TOKEN: SECRET,
  ANTHROPIC_PROFILE: 'work',
  ANTHROPIC_FEDERATION_RULE_ID: 'rule',
  ANTHROPIC_ORGANIZATION_ID: 'org',
});

describe('describe(): what is signed in, asked of the CLI', () => {
  it('an empty directory: not signed in, no billing, and the CLI used the directory asked for', async () => {
    const account = tmp();
    const cli = standIn({});
    const status = await describeClaudeAccount(account, { ...cli, cwd: tmp() });
    expect(status).toMatchObject({ signedIn: false, method: 'none', cliAuthMethod: 'none', billing: 'none', configDirectoryMatches: true });
    expect(status.email).toBeUndefined();
    expect(cli.runs()[0].args).toEqual([...cli.binaryArgs.slice(1), 'auth', 'status', '--json']);
  });

  it('a subscription login: the method, the email and plan the CLI printed, and subscription billing', async () => {
    const account = tmp();
    const cli = standIn({ [account]: SUBSCRIPTION });
    const status = await claudeAccounts.describe(account, { ...cli, cwd: tmp() });
    expect(status).toMatchObject({
      signedIn: true, method: 'subscription', billing: 'subscription', email: 'person@example.com',
      organizationName: 'Example', subscriptionType: 'max', loginExpiresAt: '2026-12-19T21:44:18.095Z', configDirectoryMatches: true,
    });
  });

  it('credentials in the parent never reach the CLI, so its login is what status reports; only NAMES come back', async () => {
    const account = tmp();
    const cli = standIn({ [account]: SUBSCRIPTION });
    const status = await describeClaudeAccount(account, { ...cli, cwd: tmp(), parentEnv: hostile(), allowEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_PROFILE'] });
    expect(status.method).toBe('subscription');
    const seen = cli.runs()[0].names.map((n) => n.toUpperCase());
    for (const name of OUTRANKING_CREDENTIALS) expect(seen).not.toContain(name);
    expect([...status.withheld].map((n) => n.toUpperCase())).toEqual(expect.arrayContaining(
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ));
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('the directory chosen replaces an inherited CLAUDE_CONFIG_DIR; null removes it', async () => {
    const account = tmp();
    const elsewhere = tmp();
    const cli = standIn({ [account]: SUBSCRIPTION });
    await describeClaudeAccount(account, { ...cli, cwd: tmp(), parentEnv: { ...process.env, claude_config_dir: elsewhere }, allowEnv: ['CLAUDE_CONFIG_DIR'] });
    await describeClaudeAccount(null, { ...cli, cwd: tmp(), parentEnv: { ...process.env, CLAUDE_CONFIG_DIR: elsewhere }, allowEnv: ['CLAUDE_CONFIG_DIR'] });
    const [chosen, fallback] = cli.runs();
    expect(chosen.configDir).toBe(resolve(account));
    expect(chosen.names.filter((n) => n.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(fallback.configDir).toBeNull();
  });

  it('refuses a relative or control-bearing directory before running anything', async () => {
    const cli = standIn({});
    await expect(describeClaudeAccount('relative/dir', cli)).rejects.toBeInstanceOf(ClaudeAccountError);
    await expect(describeClaudeAccount(join(tmp(), 'a\u0000b'), cli)).rejects.toBeInstanceOf(ClaudeAccountError);
    expect(cli.runs()).toEqual([]);
  });
});

describe('the parsed status keeps named fields only', () => {
  it('drops fields it does not know, whatever they hold, and strips terminal escapes', () => {
    const status = claudeAccountStatusOf({ ...SUBSCRIPTION, email: 'a\u001b[31m@example.com', accessToken: SECRET, refreshToken: SECRET }, null);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(status.email).toBe('a@example.com');
  });

  it('classifies each documented authMethod, and keeps an unknown one as `other` with its raw value', () => {
    const m = (raw: Record<string, unknown>) => claudeAccountStatusOf({ loggedIn: true, ...raw }, null);
    expect(m({ authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' })).toMatchObject({ method: 'apiKey', billing: 'apiUsage' });
    expect(m({ authMethod: 'api_key', apiKeySource: '/login managed key' })).toMatchObject({ method: 'console', billing: 'apiUsage' });
    expect(m({ authMethod: 'api_key_helper' })).toMatchObject({ method: 'apiKey', billing: 'apiUsage' });
    expect(m({ authMethod: 'oauth_token' })).toMatchObject({ method: 'other', cliAuthMethod: 'oauth_token', billing: 'unknown' });
    expect(m({ authMethod: 'something-new' })).toMatchObject({ method: 'other', cliAuthMethod: 'something-new' });
  });

  it('a CLI reporting another directory than the one chosen is flagged', () => {
    const chosen = tmp();
    expect(claudeAccountStatusOf({ ...SUBSCRIPTION, configDirectory: tmp() }, chosen).configDirectoryMatches).toBe(false);
    expect(claudeAccountStatusOf({ ...SUBSCRIPTION, configDirectory: chosen.replace(/\\/g, '/') }, chosen).configDirectoryMatches).toBe(true);
    expect(claudeAccountStatusOf({ ...SUBSCRIPTION, configDirectory: join(homedir(), '.claude') }, null).configDirectoryMatches).toBe(true);
  });
});

describe('a mismatch is a typed state, not a log line', () => {
  const account = (over: Partial<ClaudeAccountStatus>): ClaudeAccountStatus => ({
    signedIn: true, method: 'subscription', cliAuthMethod: 'claude.ai', billing: 'subscription', email: 'person@example.com',
    configDirectoryMatches: true, loginExpiresAt: null, withheld: [], ...over,
  });
  const selected = { configDir: '/accounts/work', method: 'subscription' as const, email: 'person@example.com' };

  it('ready, signed out, and each kind of difference', () => {
    expect(claudeAccountCheck(selected, account({})).state).toBe('ready');
    expect(claudeAccountCheck(selected, account({ signedIn: false, method: 'none', billing: 'none', email: undefined })).state).toBe('signedOut');
    expect(claudeAccountCheck(selected, account({ method: 'apiKey', cliAuthMethod: 'api_key', billing: 'apiUsage', email: undefined })))
      .toMatchObject({ state: 'mismatch', differences: ['method'], expected: selected });
    expect(claudeAccountCheck(selected, account({ email: 'someone-else@example.com' }))).toMatchObject({ state: 'mismatch', differences: ['email'] });
    expect(claudeAccountCheck(selected, account({ email: 'PERSON@example.com' })).state).toBe('ready');
    expect(claudeAccountCheck(selected, account({ configDirectoryMatches: false }))).toMatchObject({ state: 'mismatch', differences: ['configDirectory'] });
  });

  it('through the CLI: a key a settings file sets (it survives env stripping) shows as a per-token mismatch', async () => {
    const dir = tmp();
    const cli = standIn({ [dir]: { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY', loginExpiresAt: null } });
    const check = await claudeAccounts.check({ configDir: dir, method: 'subscription', email: 'person@example.com' }, { ...cli, cwd: tmp() });
    expect(check).toMatchObject({ state: 'mismatch', differences: ['method'], account: { method: 'apiKey', billing: 'apiUsage' } });
  });
});

describe('loginCommand(): what the host shows the person', () => {
  it('runs the CLI\'s own login in the chosen directory, with every credential removed', () => {
    const dir = join(tmp(), "o'brien work");
    const login = claudeLoginCommand(dir, { parentEnv: hostile(), binary: 'claude' });
    expect(login.command).toBe('claude');
    expect(login.args).toEqual(['auth', 'login', '--claudeai']);
    expect(login.set).toEqual({ CLAUDE_CONFIG_DIR: resolve(dir) });
    expect(login.env.CLAUDE_CONFIG_DIR).toBe(resolve(dir));
    for (const name of Object.keys(login.env)) expect(OUTRANKING_CREDENTIALS).not.toContain(name.toUpperCase());
    expect(JSON.stringify(login)).not.toContain(SECRET);
    expect(login.unset).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE']));
    expect(login.display.posix).toContain(`CLAUDE_CONFIG_DIR='${resolve(dir).replace(/'/g, `'\\''`)}'`);
    expect(login.display.powershell).toContain(`$env:CLAUDE_CONFIG_DIR = '${resolve(dir).replace(/'/g, "''")}'`);
    expect(login.display.powershell).toContain("& 'claude' 'auth' 'login' '--claudeai'");
    expect(login.caveats).toEqual([]);
  });

  it('the default directory unsets CLAUDE_CONFIG_DIR; a Console login carries its documented caveats', () => {
    const login = claudeLoginCommand(null, { method: 'console', email: 'person@example.com', parentEnv: { ...process.env, CLAUDE_CONFIG_DIR: tmp() } });
    expect(login.args).toEqual(['auth', 'login', '--console', '--email', 'person@example.com']);
    expect(login.set).toEqual({});
    expect(login.unset[0]).toBe('CLAUDE_CONFIG_DIR');
    expect(Object.keys(login.env).map((n) => n.toUpperCase())).not.toContain('CLAUDE_CONFIG_DIR');
    expect(login.caveats.join(' ')).toMatch(/outside the configuration directory/);
    expect(login.caveats.join(' ')).toMatch(/signs out of any claude\.ai login/);
  });

  it('refuses an email or directory that could become shell syntax', () => {
    expect(() => claudeLoginCommand(tmp(), { email: "x@y.com'; rm -rf ~" })).toThrow(ClaudeAccountError);
    expect(() => claudeLoginCommand(tmp(), { email: 'not an email' })).toThrow(ClaudeAccountError);
    expect(() => claudeLoginCommand('relative')).toThrow(ClaudeAccountError);
    expect(() => claudeLoginCommand(tmp(), { method: 'apiKey' as never })).toThrow(ClaudeAccountError);
  });
});

describe('ClaudeDriver configDir', () => {
  it('sets CLAUDE_CONFIG_DIR for that launch, replacing an inherited one, and withholds credentials', async () => {
    const account = tmp();
    const cli = standIn({});
    const driver = new ClaudeDriver({ cwd: tmp(), ...cli, configDir: account, parentEnv: { ...hostile(), CLAUDE_CONFIG_DIR: tmp() } }, {});
    driver.start();
    try {
      const run = await until('the launch', () => cli.runs()[0]);
      expect(run.configDir).toBe(resolve(account));
      for (const name of OUTRANKING_CREDENTIALS) expect(run.names.map((n) => n.toUpperCase())).not.toContain(name);
      expect(driver.withheldCredentials).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE']));
    } finally {
      await driver.stop({ graceMs: 0 });
    }
  });

  it('null launches the default account even when the parent moved it; omitted keeps the inherited one', async () => {
    const moved = tmp();
    const cli = standIn({});
    for (const configDir of [null, undefined]) {
      const driver = new ClaudeDriver({ cwd: tmp(), ...cli, parentEnv: { ...process.env, CLAUDE_CONFIG_DIR: moved }, ...(configDir === undefined ? {} : { configDir }) }, {});
      driver.start();
      await until('the launch', () => cli.runs()[configDir === null ? 0 : 1]);
      await driver.stop({ graceMs: 0 });
    }
    expect(cli.runs().map((r) => r.configDir)).toEqual([null, moved]);
  });

  it('refuses a relative directory, and a directory combined with API-key credentials', () => {
    expect(() => new ClaudeDriver({ cwd: tmp(), configDir: 'relative' })).toThrow(ClaudeAccountError);
    expect(() => new ClaudeDriver({ cwd: tmp(), configDir: tmp(), credentials: { mode: 'apiKey', apiKey: 'sk-ant-x', home: tmp() } })).toThrow(/configDir/);
  });

  it('listModels takes the same choice, and refuses it for Codex', async () => {
    await expect(listModels('codex', { configDir: tmp() })).rejects.toThrow(/Claude option/);
  });
});

describe('the library never opens a file under the account directory', () => {
  it('describe, check, loginCommand and a driver launch touch no path inside it', async () => {
    const account = tmp('prism-accounts-watched-');
    const cli = standIn({ [account]: SUBSCRIPTION });
    const cwd = tmp();
    // Something a careless implementation might read, sitting where Claude Code keeps it.
    writeFileSync(join(account, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
    watch.active = true;
    try {
      await claudeAccounts.describe(account, { ...cli, cwd });
      await claudeAccounts.check({ configDir: account, method: 'subscription' }, { ...cli, cwd });
      claudeAccounts.loginCommand(account);
      const driver = new ClaudeDriver({ cwd, ...cli, configDir: account }, {});
      driver.start();
      await until('the launch', () => (cli.runs().length >= 3 ? true : undefined));
      await driver.stop({ graceMs: 0 });
    } finally {
      watch.active = false;
    }
    // The spy saw real traffic (the stand-in's own files), so an empty result below is not a broken spy.
    expect(watch.paths.length).toBeGreaterThan(0);
    const root = resolve(account).toLowerCase();
    const inside = watch.paths.filter((p) => { const r = resolve(p).toLowerCase(); return r === root || r.startsWith(root + sep); });
    expect(inside).toEqual([]);
  });
});
