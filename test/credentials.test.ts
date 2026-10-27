import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiKeyHome } from '../src/credentials.js';
import { ClaudeDriver } from '../src/claude/driver.js';
import { CodexDriver } from '../src/codex/driver.js';
import { encodeLine } from '../src/ndjson.js';

vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  spawn: vi.fn(),
}));
vi.mock('../src/process-tree.js', async () => ({
  ...await vi.importActual<typeof import('../src/process-tree.js')>('../src/process-tree.js'),
  launchProvider: (await import('./fake-launch.js')).fakeLaunch,
}));

/**
 * API-KEY MODE NEVER TOUCHES THE PERSON'S OWN LOGIN, AND SUBSCRIPTION MODE NEVER LETS A KEY IN. The key reaches the CLI
 * only when the app says so, with an app-owned configuration home, never through argv; a home that is the person's own
 * subscription home is refused; and with no credentials (or `subscription`) every inherited key stays withheld, as it
 * always has. See src/credentials.ts for what was measured against the real CLIs.
 */

const KEY = 'sk-ant-api03-test-key-not-real';
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'prism-acp-credentials-'));
  vi.mocked(spawn).mockReset();
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('apiKeyHome: what it accepts, and what it refuses without naming the key', () => {
  it('is null for subscription credentials, and for none', () => {
    expect(apiKeyHome('claude', undefined)).toBeNull();
    expect(apiKeyHome('codex', { mode: 'subscription' })).toBeNull();
  });

  it.each(['claude', 'codex'] as const)('does not read unrelated credential environment values while validating %s homes', (provider) => {
    let reads = 0;
    const parent: Record<string, string | undefined> = { [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: join(scratch, 'existing-subscription') };
    Object.defineProperty(parent, 'CLAUDE_CODE_OAUTH_TOKEN', { enumerable: true, get: () => { reads++; throw new Error('Unrelated credential value was accessed'); } });
    const home = join(scratch, 'app-owned');
    expect(apiKeyHome(provider, { mode: 'apiKey', apiKey: KEY, home }, parent)?.home).toBe(home);
    expect(reads).toBe(0);
  });

  it('creates a missing home, and accepts an existing one', () => {
    const home = join(scratch, 'tenant-a', 'claude');
    expect(apiKeyHome('claude', { mode: 'apiKey', apiKey: KEY, home })).toEqual({ apiKey: KEY, home });
    expect(statSync(home).isDirectory()).toBe(true);
    expect(apiKeyHome('claude', { mode: 'apiKey', apiKey: KEY, home })?.home).toBe(home);
  });

  it.each([
    ['an empty key', { apiKey: '', home: 'H' }, 'credentials.apiKey'],
    ['a blank key', { apiKey: '   ', home: 'H' }, 'credentials.apiKey'],
    ['a key with a newline', { apiKey: `${KEY}\nX=1`, home: 'H' }, 'credentials.apiKey'],
    ['a relative home', { apiKey: KEY, home: 'relative/home' }, 'credentials.home must be an absolute path'],
  ])('refuses %s', (_, given, message) => {
    const home = given.home === 'H' ? join(scratch, 'h') : given.home;
    let error: Error | undefined;
    try { apiKeyHome('claude', { mode: 'apiKey', apiKey: given.apiKey, home }); } catch (cause) { error = cause as Error; }
    expect(error?.message).toContain(message);
    expect(error?.message).not.toContain('sk-ant');
  });

  it('refuses a home that is a file', () => {
    const file = join(scratch, 'file');
    writeFileSync(file, '');
    expect(() => apiKeyHome('codex', { mode: 'apiKey', apiKey: KEY, home: file })).toThrow('not a directory');
  });

  it.each([
    ['claude', join(homedir(), '.claude')],
    ['codex', join(homedir(), '.codex')],
  ] as const)('refuses %s\'s default subscription home: a key there replaces or mixes with the person\'s login', (provider, home) => {
    expect(() => apiKeyHome(provider, { mode: 'apiKey', apiKey: KEY, home }, {})).toThrow('own');
  });

  it('refuses the home the environment moved the subscription login to, whatever the variable\'s case', () => {
    const moved = join(scratch, 'moved-login');
    expect(() => apiKeyHome('claude', { mode: 'apiKey', apiKey: KEY, home: moved }, { claude_config_dir: moved })).toThrow('own');
    expect(() => apiKeyHome('codex', { mode: 'apiKey', apiKey: KEY, home: `${moved}/` }, { CODEX_HOME: moved })).toThrow('own');
    expect(existsSync(moved)).toBe(false);
  });
});

/** A provider process that records what it was given and answers Codex's requests. */
class Provider extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  readonly sent: Record<string, unknown>[] = [];
  readonly kill = vi.fn(() => true);

  constructor(loginAnswer: unknown = { type: 'apiKey' }) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trimEnd().split('\n')) {
        const request = JSON.parse(line) as Record<string, unknown>;
        this.sent.push(request);
        if (typeof request.id !== 'number') continue;
        let result: unknown = {};
        if (request.method === 'account/login/start') result = loginAnswer;
        if (request.method === 'thread/start') result = { thread: { id: 'thread-1' } };
        queueMicrotask(() => this.stdout.write(encodeLine({ jsonrpc: '2.0', id: request.id, result })));
      }
    });
    queueMicrotask(() => this.emit('spawn'));
  }
}

function spawned(loginAnswer?: unknown) {
  const children: Provider[] = [];
  vi.mocked(spawn).mockImplementation(() => {
    const child = new Provider(loginAnswer);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const last = () => {
    const call = vi.mocked(spawn).mock.calls.at(-1)!;
    return { args: call[1] as string[], env: (call[2] as { env: Record<string, string> }).env, child: children.at(-1)! };
  };
  return { last };
}

const INHERITED = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-inherited', OPENAI_API_KEY: 'sk-inherited' };

describe('Claude: the key reaches the CLI only in API-key mode, and only through its environment', () => {
  it('subscription mode (the default) withholds every inherited key, as before', () => {
    const { last } = spawned();
    const driver = new ClaudeDriver({ cwd: scratch, parentEnv: INHERITED });
    driver.start();
    const { env } = last();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(driver.withheldCredentials).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    driver.kill();
  });

  it('API-key mode gives the CLI the app\'s key and the app\'s home, never in argv, and still withholds inherited keys', () => {
    const { last } = spawned();
    const home = join(scratch, 'tenant');
    const driver = new ClaudeDriver({ cwd: scratch, parentEnv: INHERITED, credentials: { mode: 'apiKey', apiKey: KEY, home } });
    driver.start();
    const { env, args } = last();
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(args.join(' ')).not.toContain(KEY);
    expect(driver.withheldCredentials).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    driver.kill();
  });

  it('API-key mode never lets the key out through stderr, even split across chunks or cut off at the end', async () => {
    const { last } = spawned();
    const lines: string[] = [];
    let exit = (): void => {};
    const exited = new Promise<void>((resolve) => { exit = resolve; });
    const driver = new ClaudeDriver({ cwd: scratch, parentEnv: INHERITED, credentials: { mode: 'apiKey', apiKey: KEY, home: join(scratch, 'tenant') } },
      { onStderr: (line) => lines.push(line), onExit: () => exit() });
    driver.start();
    const { child } = last();
    for (const chunk of ['Invalid API key: ', KEY.slice(0, 9), `${KEY.slice(9)} (check ANTHROPIC_API_KEY)\n`, 'echo ', KEY.slice(0, 15)]) {
      child.stderr.write(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    child.stderr.end();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 1, null);
    await exited;

    const everything = driver.stderr + lines.join('\n');
    expect(everything).not.toContain(KEY.slice(0, 12));
    // Lines are emitted per released chunk, as they always were; the text is what matters.
    expect(driver.stderr).toBe('Invalid API key: [redacted] (check ANTHROPIC_API_KEY)\necho [redacted]');
    expect(lines.join('')).toBe('Invalid API key: [redacted] (check ANTHROPIC_API_KEY)echo [redacted]');
  });

  it('subscription mode passes stderr through unchanged', async () => {
    const { last } = spawned();
    const lines: string[] = [];
    const driver = new ClaudeDriver({ cwd: scratch, parentEnv: INHERITED }, { onStderr: (line) => lines.push(line) });
    driver.start();
    last().child.stderr.write(`diagnostic ${KEY}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual([`diagnostic ${KEY}`]);
    driver.kill();
  });

  it('refuses before anything starts when the home is the person\'s own', () => {
    spawned();
    const driver = new ClaudeDriver({ cwd: scratch, parentEnv: {}, credentials: { mode: 'apiKey', apiKey: KEY, home: join(homedir(), '.claude') } });
    expect(() => driver.start()).toThrow('own');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});

describe('Codex: API-key mode logs the app-server in under the app\'s CODEX_HOME before any thread starts', () => {
  it('sets CODEX_HOME, logs in with the key over the protocol, then starts the thread', async () => {
    const { last } = spawned();
    const home = join(scratch, 'tenant');
    const driver = new CodexDriver({ cwd: scratch, parentEnv: INHERITED, credentials: { mode: 'apiKey', apiKey: KEY, home } });
    driver.start();
    await driver.ready;
    const { env, args, child } = last();
    const methods = child.sent.map((frame) => frame.method);
    expect(env.CODEX_HOME).toBe(home);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(args.join(' ')).not.toContain(KEY);
    expect(methods.indexOf('account/login/start')).toBeGreaterThan(methods.indexOf('initialized'));
    expect(methods.indexOf('account/login/start')).toBeLessThan(methods.indexOf('thread/start'));
    expect(child.sent.find((frame) => frame.method === 'account/login/start')?.params).toEqual({ type: 'apiKey', apiKey: KEY });
    driver.kill();
  });

  it('subscription mode sends no login at all', async () => {
    const { last } = spawned();
    const driver = new CodexDriver({ cwd: scratch, parentEnv: INHERITED });
    driver.start();
    await driver.ready;
    expect(last().child.sent.map((frame) => frame.method)).not.toContain('account/login/start');
    expect(last().env.CODEX_HOME).toBeUndefined();
    driver.kill();
  });

  it('a login the app-server does not confirm stops the startup, and the key is not in what is reported', async () => {
    const { last } = spawned({});
    const problems: string[] = [];
    const driver = new CodexDriver(
      { cwd: scratch, parentEnv: {}, credentials: { mode: 'apiKey', apiKey: KEY, home: join(scratch, 't') } },
      { onProtocolError: (problem) => problems.push(problem) },
    );
    driver.start();
    await driver.ready.catch(() => {});
    expect(last().child.sent.map((frame) => frame.method)).not.toContain('thread/start');
    expect(problems.join(' ')).not.toContain('sk-ant');
    driver.kill();
  });
});
