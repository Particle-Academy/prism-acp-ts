import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver, CodexDriver, encodeLine, type CodexDriverOptions, type ClaudeDriverOptions, type McpServer } from '../src/index.js';
import { measureNativeCase, measuring } from './fixtures/windows-native-timing.mjs';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { timedExecFileSync } = await import('./fixtures/windows-native-timing.mjs');
  return { ...actual, spawn: vi.fn(), execFileSync: (...args: any[]) => timedExecFileSync(actual.execFileSync, ...args) };
});
vi.mock('../src/process-tree.js', async () => ({
  ...await vi.importActual<typeof import('../src/process-tree.js')>('../src/process-tree.js'),
  launchProvider: (await import('./fake-launch.js')).fakeLaunch,
}));

const TOKEN = 'per-session-fixture-only';
const server = (token = TOKEN): McpServer => ({ type: 'http', name: 'tynn', url: 'https://example.test/mcp', headers: [{ name: 'aUtHoRiZaTiOn', value: `Bearer ${token}` }] });
type Disabled = { disabledMcpServers?: readonly string[] };
const drivers: Array<ClaudeDriver | CodexDriver> = [];
beforeEach(() => { vi.mocked(spawn).mockReset(); });
afterEach(() => { for (const driver of drivers.splice(0)) driver.kill(); });

async function codex(options: Partial<CodexDriverOptions> & Disabled = {}, disk: Record<string, unknown> = {}, effective: Record<string, unknown> | ((env: Readonly<Record<string, string>>) => Record<string, unknown>) = {}) {
  const frames: Array<{ method?: string; params?: any }> = [];
  let childEnv: Readonly<Record<string, string>> = {};
  const errors: string[] = [];
  const driver = new CodexDriver({ cwd: '/workspace', mcpServers: [server()], parentEnv: { PATH: process.env.PATH, LEGACY_MCP_KEY: 'legacy-fixture' }, allowEnv: ['LEGACY_MCP_KEY'], ...options }, { onProtocolError: (error) => errors.push(error) }, (launch, handlers) => {
    childEnv = launch.env;
    return {
      start: async () => {}, close: () => {},
      send: (value) => {
        const frame = value as { id?: number; method?: string; params?: any }; frames.push(frame);
        if (frame.id === undefined) return;
        let result: unknown = {};
        if (frame.method === 'config/read') result = { config: { ...(typeof effective === 'function' ? effective(childEnv) : effective), mcp_servers: disk } };
        if (frame.method === 'thread/start') result = { thread: { id: 'thread-isolated' } };
        if (frame.method === 'thread/resume') result = { thread: { id: frame.params.threadId } };
        if (frame.method === 'thread/turns/list') result = { data: [], nextCursor: null };
        queueMicrotask(() => handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
      },
    };
  });
  drivers.push(driver); driver.start(); await driver.ready;
  const started = frames.find((frame) => frame.method === 'thread/start' || frame.method === 'thread/resume');
  return { driver, frames, childEnv, errors, config: started?.params.config };
}

describe('explicit Codex MCP bearer wins over inherited authentication', () => {
  for (const resume of [false, true]) {
    it(`binds the bearer through this child environment on ${resume ? 'resume' : 'start'}`, async () => {
      const parent = { PATH: process.env.PATH, LEGACY_MCP_KEY: 'legacy-fixture' };
      const t = await codex({ parentEnv: parent, ...(resume ? { resumeSessionId: 'thread-isolated' } : {}) });
      const name = t.config?.mcp_servers?.tynn?.bearer_token_env_var;
      expect(typeof name).toBe('string'); expect(name).toMatch(/^PRISM_ACP_MCP_TOKEN_[A-F0-9]+$/);
      expect(t.childEnv[name]).toBe(TOKEN);
      expect(t.childEnv.LEGACY_MCP_KEY).toBe('legacy-fixture'); // the inherited-key control really is present
      expect(parent).toEqual({ PATH: process.env.PATH, LEGACY_MCP_KEY: 'legacy-fixture' });
      expect(JSON.stringify(t.config)).not.toContain('legacy-fixture');
      expect(t.errors).toEqual([]);
    });
  }
  it('two driver instances have separate bearer bindings and never receive the other agent key', async () => {
    const a = await codex({ mcpServers: [server('agent-one-fixture')] });
    const b = await codex({ mcpServers: [server('agent-two-fixture')] });
    const nameA = a.config?.mcp_servers?.tynn?.bearer_token_env_var;
    const nameB = b.config?.mcp_servers?.tynn?.bearer_token_env_var;
    expect(typeof nameA).toBe('string'); expect(typeof nameB).toBe('string'); expect(nameA).not.toBe(nameB);
    expect(a.childEnv[nameA]).toBe('agent-one-fixture'); expect(b.childEnv[nameB]).toBe('agent-two-fixture');
    expect(JSON.stringify(a.childEnv)).not.toContain('agent-two-fixture');
    expect(JSON.stringify(b.childEnv)).not.toContain('agent-one-fixture');
  });
  it('normalizes outer HTTP whitespace before classifying explicit bearer credentials', async () => {
    const t = await codex({ mcpServers: [{ ...server(), headers: [{ name: 'Authorization', value: ` \tBearer ${TOKEN} \t` }] }] });
    const binding = t.config?.mcp_servers?.tynn?.bearer_token_env_var;
    expect(typeof binding).toBe('string');
    expect(t.childEnv[binding]).toBe(TOKEN);
    expect(JSON.stringify(t.config)).not.toContain(TOKEN);
    expect(t.errors).toEqual([]);
  });
  it('keeps the bearer out of thread configuration that the CLI may persist', async () => {
    const t = await codex();
    const binding = t.config?.mcp_servers?.tynn?.bearer_token_env_var;
    expect(t.childEnv[binding]).toBe(TOKEN);
    expect(JSON.stringify(t.config)).not.toContain(TOKEN);
    expect(t.config.features.shell_snapshot).toBe(false);
    expect(Object.keys(t.config.mcp_servers.tynn.http_headers).map((name) => name.toLowerCase())).not.toContain('authorization');
  });
});

describe('Codex shell environment cannot inherit explicit MCP bearer bindings', () => {
  for (const resume of [false, true]) {
    it(`appends per-binding exclusions to the effective hostile policy on ${resume ? 'resume' : 'start'}`, async () => {
      const policy = { inherit: 'all', ignore_default_excludes: true, exclude: ['USER_PRIVATE_*'],
        set: { KEEP_SETTING: 'present' }, include_only: ['*'], filters: null };
      const t = await codex(resume ? { resumeSessionId: 'thread-isolated' } : {}, {}, { shell_environment_policy: policy });
      const binding = t.config.mcp_servers.tynn.bearer_token_env_var;
      expect(t.frames.filter((frame) => frame.method === 'config/read')).toHaveLength(1);
      expect(t.config.shell_environment_policy).toEqual({ ...policy, filters: undefined, exclude: ['USER_PRIVATE_*', binding] });
      expect(t.childEnv[binding]).toBe(TOKEN);
      expect(policy.exclude).toEqual(['USER_PRIVATE_*']);
      expect(JSON.stringify(t.config)).not.toContain(TOKEN);
    });
  }
  it('excludes every fresh binding without removing an unrelated keyed filter', async () => {
    const t = await codex({ mcpServers: [server(), { ...server('second-fixture'), name: 'second' }] }, {}, {
      shell_environment_policy: { inherit: 'all', ignore_default_excludes: true,
        filters: { 'USER_PRIVATE_*': 'exclude', 'VISIBLE_*': 'include' }, exclude: null, set: null },
    });
    const bindings = Object.keys(t.childEnv).filter((name) => name.startsWith('PRISM_ACP_MCP_TOKEN_'));
    expect(bindings).toHaveLength(2);
    expect(t.config.shell_environment_policy.filters).toEqual({ 'USER_PRIVATE_*': 'exclude', 'VISIBLE_*': 'include',
      ...Object.fromEntries(bindings.map((name) => [name, 'exclude'])) });
    expect(t.config.shell_environment_policy).not.toHaveProperty('exclude');
  });
  it('leaves unrelated policies alone when no bearer is forwarded', async () => {
    const t = await codex({ mcpServers: [] });
    expect(t.frames.some((frame) => frame.method === 'config/read')).toBe(false);
    expect(t.config).toBeUndefined();
  });
  it('refuses malformed effective policies before starting a thread', async () => {
    for (const policy of [[], { exclude: 'bad' }, { exclude: [1] }, { set: [] }, { filters: [] }, { filters: { '*': 'bad' } }]) {
      const t = await codex({}, {}, { shell_environment_policy: policy });
      expect(t.errors).toEqual(['Codex app-server startup failed (Error)']);
      expect(t.frames.some((frame) => frame.method === 'thread/start')).toBe(false);
    }
  });
  it('refuses a policy that would restore a fresh binding through set, case-insensitively', async () => {
    const t = await codex({}, {}, (env) => {
      const binding = Object.keys(env).find((name) => name.startsWith('PRISM_ACP_MCP_TOKEN_'))!;
      return { shell_environment_policy: { set: { [binding.toLowerCase()]: 'restored-fixture' } } };
    });
    expect(t.errors).toEqual(['Codex app-server startup failed (Error)']);
    expect(t.frames.some((frame) => frame.method === 'thread/start')).toBe(false);
  });
});

describe('selective Codex MCP disable is valid for existing and absent entries', () => {
  for (const [label, entry] of [['http', { url: 'https://legacy.test/mcp' }], ['stdio', { command: 'legacy-fixture', args: [] }], ['absent', undefined]] as const) {
    it(`${label}: disables only the named inherited server and preserves the explicit server`, async () => {
      const t = await codex({ mcpServers: [{ type: 'http', name: 'genie', url: 'http://127.0.0.1:1234/mcp', headers: [] }], disabledMcpServers: ['tynn'] }, entry ? { tynn: entry } : {});
      expect(t.config?.mcp_servers?.tynn?.enabled).toBe(false);
      expect(t.config?.mcp_servers?.genie?.url).toBe('http://127.0.0.1:1234/mcp');
      if (entry && 'command' in entry) {
        expect(t.config.mcp_servers.tynn.command).toBe(entry.command);
        expect(t.config.mcp_servers.tynn).not.toHaveProperty('url');
      } else if (entry) expect(t.config.mcp_servers.tynn.url).toBe(entry.url);
      else expect(typeof t.config.mcp_servers.tynn.url).toBe('string');
      // A CLI-only entry can be present in config/read but absent from the disk layer thread/start rebuilds.
      // Carry its effective transport while disabled, so both paths remain valid without changing stdio to HTTP.
      expect(t.frames.some((frame) => frame.method === 'config/read')).toBe(true);
      expect(t.errors).toEqual([]);
    });
  }
  it('copies the disabled-name list before asynchronous startup', async () => {
    const names = ['tynn'];
    const work = codex({ mcpServers: [], disabledMcpServers: names }); names.push('genie');
    const t = await work;
    expect(t.config?.mcp_servers?.tynn?.enabled).toBe(false);
    expect(t.config?.mcp_servers).not.toHaveProperty('genie');
  });
});

class Child extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); readonly exitCode = null;
  constructor() {
    super(); this.stdin.on('data', (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString());
      if (frame.type === 'control_request') queueMicrotask(() => this.stdout.write(encodeLine({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [{ value: 'fixture', displayName: 'Fixture' }] } } })));
    }); queueMicrotask(() => this.emit('spawn'));
  }
  kill(): boolean { this.emit('close', 0, null); return true; }
}

describe('Claude selective MCP deny shares its final private settings with approval hooks', () => {
  for (const hooks of [false, true]) {
    for (let sample = 1; sample <= (measuring && hooks && process.env.PRISM_ACP_NATIVE_VARIANT === 'full-suite' ? 30 : 1); sample++) {
    it(`${hooks ? 'with' : 'without'} hooks: writes one settings source, preserves hook approval and removes it at exit${measuring ? ` sample ${sample}` : ''}`, () => measureNativeCase(sample, () => {
      let args: readonly string[] = []; let settings: any; let path: string | undefined;
      vi.mocked(spawn).mockImplementation((_binary, argv) => {
        args = argv as string[]; const index = args.indexOf('--settings'); path = index >= 0 ? args[index + 1] : undefined;
        if (path) settings = JSON.parse(readFileSync(path, 'utf8'));
        return new Child() as unknown as ChildProcess;
      });
      const options: ClaudeDriverOptions & Disabled = { cwd: process.cwd(), disabledMcpServers: ['tynn'], ...(hooks ? { permissionPrompts: { tools: ['Bash'] } } : {}) };
      const driver = new ClaudeDriver(options); drivers.push(driver); driver.start();
      expect(settings?.deniedMcpServers).toEqual([{ serverName: 'tynn' }]);
      expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
      if (hooks) expect(settings.hooks.PreToolUse).toHaveLength(1);
      if (process.platform !== 'win32') expect(statSync(path!).mode & 0o777).toBe(0o600);
      driver.kill(); expect(existsSync(path!)).toBe(false);
    }), measuring ? 120_000 : undefined);
    }
  }
});

describe('MCP disable is validated before any provider starts', () => {
  for (const Driver of [ClaudeDriver, CodexDriver]) {
    it(`${Driver.name}: refuses contradictory and invalid disabled names`, () => {
      expect(() => new Driver({ cwd: process.cwd(), mcpServers: [server()], disabledMcpServers: ['tynn'] } as any)).toThrow(/disabledMcpServers/);
      for (const names of [[''], ['tynn', 'tynn'], [`bad\0${TOKEN}`]]) {
        expect(() => new Driver({ cwd: process.cwd(), disabledMcpServers: names } as any)).toThrow(/disabledMcpServers/);
      }
      expect(spawn).not.toHaveBeenCalled();
    });
  }
});
