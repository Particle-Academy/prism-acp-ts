import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, ClaudeDriver, CodexDriver, CLAUDE_DRIVER_CAPABILITIES,
  CODEX_DRIVER_CAPABILITIES, claudeArgs, encodeLine } from '../src/index.js';

vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  spawn: vi.fn(),
}));
vi.mock('../src/process-tree.js', async () => ({
  ...await vi.importActual<typeof import('../src/process-tree.js')>('../src/process-tree.js'),
  // The provider is spawned directly through the intercepted spawn; containment is tested in process-tree.test.ts.
  launchProvider: (await import('./fake-launch.js')).fakeLaunch,
}));

const TOKEN = 'fixture-only-"&|%TOKEN%!$`-token';
const SERVERS = [
  { type: 'http', name: 'loopback', url: 'http://127.0.0.1:43210/mcp',
    headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }, { name: 'X-Client', value: 'acp' }] },
  { name: 'local', command: '/opt/MCP server/bin', args: ['--label', 'two words', '"&|%TOKEN%!$`'],
    env: [{ name: 'MCP_TOKEN', value: TOKEN }, { name: 'EMPTY', value: '' }] },
  { name: 'second', command: '/opt/other', args: [], env: [] },
];

/** Only the OS spawn is intercepted. ACP, both drivers and Codex stdio are real. */
class ProviderChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  readonly sent: Record<string, unknown>[] = [];
  kill(): boolean { this.emit('close', 0, null); return true; }

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trimEnd().split('\n')) {
        const request = JSON.parse(line) as Record<string, unknown>;
        this.sent.push(request);
        if (typeof request.id !== 'number') continue;
        const params = request.params as Record<string, unknown>;
        let result: unknown = {};
        if (request.method === 'thread/start') result = { thread: { id: 'thread-captured' } };
        if (request.method === 'thread/resume') result = { thread: { id: params.threadId } };
        if (request.method === 'thread/turns/list') result = { data: [], nextCursor: null };
        if (request.method === 'account/rateLimits/read') result = {
          rateLimits: { primary: null, secondary: null },
        };
        queueMicrotask(() => this.stdout.write(encodeLine({ jsonrpc: '2.0', id: request.id, result })));
      }
    });
    queueMicrotask(() => this.emit('spawn'));
  }
}

beforeEach(() => { vi.mocked(spawn).mockReset(); });

function client(provider: 'claude' | 'codex') {
  const children: ProviderChild[] = [];
  const configs: unknown[] = [];
  const configPaths: string[] = [];
  vi.mocked(spawn).mockImplementation((_binary, args) => {
    const argv = args as string[];
    const flag = argv.indexOf('--mcp-config');
    if (flag !== -1) {
      // Read as given: a path the CLI could not open as-is (quoted, say) must fail here too.
      const path = argv[flag + 1];
      configPaths.push(path);
      configs.push(JSON.parse(readFileSync(path, 'utf8')));
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      }
    }
    const child = new ProviderChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: { id?: number; error?: { code: number; message: string }; result?: unknown }[] = [];
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) frames.push(JSON.parse(line));
  });
  const problems: string[] = [];
  const drivers: (ClaudeDriver | CodexDriver)[] = [];
  const served = serve({
    input, output,
    driverCapabilities: provider === 'claude' ? CLAUDE_DRIVER_CAPABILITIES : CODEX_DRIVER_CAPABILITIES,
    driverFactory: (options, events) => {
      const driver = provider === 'claude'
        ? new ClaudeDriver({ ...options, parentEnv: { ANTHROPIC_API_KEY: 'ambient-must-be-withheld' } }, events)
        : new CodexDriver({ ...options, parentEnv: { OPENAI_API_KEY: 'ambient-must-be-withheld' } }, events);
      drivers.push(driver);
      return driver;
    },
    onProtocolError: (_id, problem) => problems.push(problem),
  });
  let id = 0;
  async function request(method: string, params: unknown) {
    const requestId = ++id;
    input.write(encodeLine({ jsonrpc: '2.0', id: requestId, method, params }));
    for (let tick = 0; tick < 200; tick++) {
      const reply = frames.find((frame) => frame.id === requestId);
      if (reply !== undefined) {
        for (const driver of drivers) if (driver instanceof CodexDriver) await driver.ready;
        return reply;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`no reply to ${method}`);
  }
  async function close() { input.end(); await served.closed; }
  return { children, configs, configPaths, problems, request, close };
}

for (const provider of ['claude', 'codex'] as const) {
  describe(`${provider}: MCP configuration from the ACP caller to the spawned provider`, () => {
    for (const method of ['session/new', 'session/load']) {
      it(`${method} delivers every HTTP and stdio entry, including headers, args and env`, async () => {
        const c = client(provider);
        try {
          const reply = await c.request(method, {
            cwd: '/work', mcpServers: SERVERS,
            ...(method === 'session/load' ? { sessionId: 'thread-resumed' } : {}),
          });
          expect(reply.error).toBeUndefined();
          expect(c.problems).toEqual([]);
          expect(c.children).toHaveLength(1);
          if (provider === 'claude') {
            expect(c.configs).toEqual([{ mcpServers: {
              loopback: { type: 'http', url: 'http://127.0.0.1:43210/mcp',
                headers: { Authorization: `Bearer ${TOKEN}`, 'X-Client': 'acp' } },
              local: { type: 'stdio', command: '/opt/MCP server/bin', args: SERVERS[1].args,
                env: { MCP_TOKEN: TOKEN, EMPTY: '' } },
              second: { type: 'stdio', command: '/opt/other', args: [], env: {} },
            } }]);
          } else {
            const handed = c.children[0].sent.find((frame) =>
              frame.method === (method === 'session/new' ? 'thread/start' : 'thread/resume'));
            expect(handed?.params).toMatchObject({ config: { mcp_servers: {
              loopback: { url: 'http://127.0.0.1:43210/mcp',
                http_headers: { Authorization: `Bearer ${TOKEN}`, 'X-Client': 'acp' } },
              local: { command: '/opt/MCP server/bin', args: SERVERS[1].args,
                env: { MCP_TOKEN: TOKEN, EMPTY: '' } },
              second: { command: '/opt/other', args: [], env: {} },
            } } });
          }
          for (const call of vi.mocked(spawn).mock.calls) {
            expect(JSON.stringify(call[1])).not.toContain(TOKEN);
            expect(call[2]?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
            expect(call[2]?.env).not.toHaveProperty('OPENAI_API_KEY');
            expect(call[2]?.env).not.toHaveProperty('MCP_TOKEN');
          }
        } finally { await c.close(); }
        for (const path of c.configPaths) {
          expect(existsSync(path)).toBe(false);
          expect(existsSync(dirname(path))).toBe(false);
        }
      });
    }

    it('advertises the supported HTTP and SSE transports on initialize', async () => {
      const c = client(provider);
      try {
        const reply = await c.request('initialize', { protocolVersion: 1 });
        expect(reply.result).toMatchObject({ agentCapabilities: {
          mcpCapabilities: { http: true, sse: provider === 'claude' },
        } });
      } finally { await c.close(); }
    });

    it.each([undefined, []])('preserves provider defaults for %j', async (mcpServers) => {
      const c = client(provider);
      try {
        expect((await c.request('session/new', { cwd: '/work', mcpServers })).error).toBeUndefined();
        expect(c.children).toHaveLength(1);
        expect(c.configs).toEqual([]);
        const start = c.children[0].sent.find((frame) => frame.method === 'thread/start');
        if (provider === 'codex') expect(start?.params).not.toHaveProperty('config');
        expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain('--mcp-config');
      } finally { await c.close(); }
    });

    it('keeps simultaneous sessions and their explicit credentials separate', async () => {
      const c = client(provider);
      try {
        await c.request('session/new', { cwd: '/first', mcpServers: [SERVERS[0]] });
        await c.request('session/new', { cwd: '/second', mcpServers: [{
          type: 'http', name: 'other', url: 'http://127.0.0.1:43211/mcp', headers: [],
        }] });
        expect(c.children).toHaveLength(2);
        const received = provider === 'claude' ? c.configs : c.children.map((child) =>
          child.sent.find((frame) => frame.method === 'thread/start')?.params);
        expect(JSON.stringify(received[0])).toContain(TOKEN.replace(/"/g, '\\"'));
        expect(JSON.stringify(received[1])).not.toContain('Authorization');
        expect(JSON.stringify(received[1])).toContain('43211');
      } finally { await c.close(); }
    });

    it('preserves __proto__ as an ordinary server and header name', async () => {
      const c = client(provider);
      try {
        const reply = await c.request('session/new', { cwd: '/work', mcpServers: [{
          type: 'http', name: '__proto__', url: 'http://127.0.0.1:43210/mcp',
          headers: [{ name: '__proto__', value: TOKEN }],
        }] });
        expect(reply.error).toBeUndefined();
        const config = provider === 'claude' ? c.configs[0] :
          (c.children[0].sent.find((frame) => frame.method === 'thread/start')?.params as
            Record<string, unknown>).config;
        expect(JSON.stringify(config)).toContain('"__proto__"');
        const servers = (config as Record<string, Record<string, Record<string, unknown>>>)[
          provider === 'claude' ? 'mcpServers' : 'mcp_servers'];
        expect(Object.hasOwn(servers, '__proto__')).toBe(true);
        const headers = servers.__proto__[provider === 'claude' ? 'headers' : 'http_headers'] as
          Record<string, string>;
        expect(Object.hasOwn(headers, '__proto__')).toBe(true);
        expect(headers.__proto__).toBe(TOKEN);
      } finally { await c.close(); }
    });

    const malformed = [
      { label: 'non-array', value: {} },
      { label: 'null entry', value: [null] },
      { label: 'duplicate server names', value: [SERVERS[0], SERVERS[0]] },
      { label: 'unknown transport', value: [{ ...SERVERS[0], type: 'websocket' }] },
      { label: 'missing name', value: [{ ...SERVERS[0], name: undefined }] },
      { label: 'missing headers', value: [{ ...SERVERS[0], headers: undefined }] },
      { label: 'non-HTTP URL', value: [{ ...SERVERS[0], url: `file:///${TOKEN}` }] },
      { label: 'relative command', value: [{ ...SERVERS[1], command: 'relative' }] },
      { label: 'non-string argument', value: [{ ...SERVERS[1], args: [null] }] },
      { label: 'missing env', value: [{ ...SERVERS[1], env: undefined }] },
      { label: 'duplicate env names', value: [{ ...SERVERS[1], env: [
        { name: 'Token', value: TOKEN }, { name: 'TOKEN', value: 'other' },
      ] }] },
      { label: 'duplicate header names', value: [{ ...SERVERS[0], headers: [
        { name: 'Authorization', value: TOKEN }, { name: 'authorization', value: 'other' },
      ] }] },
      { label: 'header injection', value: [{ ...SERVERS[0], headers: [
        { name: 'Authorization', value: `${TOKEN}\r\nInjected: yes` },
      ] }] },
    ];
    for (const method of ['session/new', 'session/load']) {
      it.each(malformed)(`${method} refuses $label before any spawn or partial forwarding`, async ({ value }) => {
        const c = client(provider);
        try {
          const reply = await c.request(method, { cwd: '/work', sessionId: 'thread-resumed', mcpServers: value });
          expect(reply.error?.code).toBe(-32602);
          expect(reply.error?.message).toMatch(/invalid mcpServers/);
          expect(JSON.stringify(reply)).not.toContain(TOKEN);
          expect(spawn).not.toHaveBeenCalled();
          expect(c.children).toEqual([]);
        } finally { await c.close(); }
      });
    }

    it('forwards SSE to Claude and refuses the entire mixed list for Codex', async () => {
      const c = client(provider);
      const sse = { type: 'sse', name: 'events', url: 'http://127.0.0.1:43212/sse',
        headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] };
      try {
        const reply = await c.request('session/new', { cwd: '/work', mcpServers: [SERVERS[0], sse] });
        if (provider === 'claude') {
          expect(reply.error).toBeUndefined();
          expect(c.configs[0]).toMatchObject({ mcpServers: { events: {
            type: 'sse', url: 'http://127.0.0.1:43212/sse', headers: { Authorization: `Bearer ${TOKEN}` },
          } } });
        } else {
          expect(reply.error?.code).toBe(-32602);
          expect(reply.error?.message).toMatch(/SSE transport is not supported/);
          expect(spawn).not.toHaveBeenCalled();
        }
      } finally { await c.close(); }
    });
  });
}

describe('Claude temporary credential file lifecycle', () => {
  if (process.platform === 'win32') {
    it('refuses to write credentials or spawn when Windows ACL protection fails', async () => {
      const c = client('claude');
      let directory = '';
      const original = execFileSync;
      const protection = vi.spyOn(childProcess, 'execFileSync').mockImplementation((...args) => {
        if (String(args[0]).endsWith('icacls.exe') && (args[1] as string[]).includes('/inheritance:r')) {
          directory = (args[1] as string[])[0];
          throw new Error(`sensitive filesystem failure ${TOKEN}`);
        }
        return Reflect.apply(original, childProcess, args);
      });
      try {
        const reply = await c.request('session/new', { cwd: '/work', mcpServers: SERVERS });
        expect(reply.error?.code).toBe(-32603);
        expect(JSON.stringify(reply)).not.toContain(TOKEN);
        expect(directory).not.toBe('');
        expect(existsSync(join(directory, 'mcp.json'))).toBe(false);
        expect(existsSync(directory)).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
      } finally { protection.mockRestore(); await c.close(); }
    });
  }

  it('protects the actual MCP credential file from other local identities', async () => {
    const c = client('claude');
    try {
      expect((await c.request('session/new', { cwd: '/work', mcpServers: SERVERS })).error).toBeUndefined();
      const path = c.configPaths[0];
      if (process.platform === 'win32') {
        const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
        const identity = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
          { encoding: 'utf8', windowsHide: true });
        const sid = identity.match(/\bS-\d+(?:-\d+)+\b/)?.[0];
        expect(sid).toBeDefined();
        const snapshot = join(dirname(path), 'acl-snapshot.txt');
        try {
          // /save gives language-independent SDDL; inspect the real filesystem ACL.
          execFileSync(join(system32, 'icacls.exe'), [path, '/save', snapshot],
            { stdio: 'pipe', windowsHide: true });
          const descriptor = readFileSync(snapshot, 'utf16le').split(/\r?\n/)
            .find((line) => line.startsWith('D:'));
          // The whole descriptor in the message, so a failure on a machine nobody may test on can be read from CI.
          const entries = descriptor?.match(/\([^)]*\)/g) ?? [];
          // SDDL names the built-in Administrator account (RID 500, as on GitHub's Windows runners) "LA", not by SID.
          const self = new Set([sid, ...(sid?.endsWith('-500') ? ['LA'] : [])]);
          const trustees = entries.map((entry) => entry.slice(1, -1).split(';')[5]);
          // The user's own entry must be there. Beside it, only SYSTEM (SY) and Administrators (BA) may appear: both can
          // read any file whatever its DACL (the OS itself; backup and take-ownership privileges), and an elevated
          // runner hands them inherited entries. Any OTHER identity -- another local user, Users, Everyone -- fails.
          expect(trustees.some((trustee) => self.has(trustee)), `descriptor: ${descriptor}`).toBe(true);
          expect(trustees.filter((trustee) => !self.has(trustee) && trustee !== 'SY' && trustee !== 'BA'), `descriptor: ${descriptor}`)
            .toEqual([]);
          expect(entries.every((entry) => entry.startsWith('(A;')), `descriptor: ${descriptor}`).toBe(true);
        } finally { if (existsSync(snapshot)) unlinkSync(snapshot); }
      } else {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      }
    } finally { await c.close(); }
  });

  it('passes a file path verbatim on every platform: no shell runs the CLI, so nothing may be pre-quoted', () => {
    // Before 0.21.0 the path was wrapped in quotes for cmd.exe. Without a shell those quotes would reach the CLI as
    // part of the path, and it would read a file that does not exist.
    for (const path of ['C:\\temp folder\\mcp.json', 'C:\\temp%folder!\\mcp.json', '/tmp/a b/mcp.json']) {
      const args = claudeArgs({ cwd: '/work' }, path, path);
      expect(args[args.indexOf('--mcp-config') + 1]).toBe(path);
      expect(args[args.indexOf('--settings') + 1]).toBe(path);
    }
  });

  it.each(['error', 'throw'] as const)('removes its config after a spawn %s', async (mode) => {
    const c = client('claude');
    let path = '';
    try {
      if (mode === 'throw') vi.mocked(spawn).mockImplementation((_binary, args) => {
        const argv = args as string[];
        path = argv[argv.indexOf('--mcp-config') + 1];
        throw new Error(`sensitive cause ${TOKEN}`);
      });
      const reply = await c.request('session/new', { cwd: '/work', mcpServers: SERVERS });
      if (mode === 'error') {
        path = c.configPaths[0];
        c.children[0].emit('error', new Error('ENOENT'));
      } else {
        expect(reply.error?.code).toBe(-32603);
        expect(JSON.stringify(reply)).not.toContain(TOKEN);
      }
      expect(existsSync(path)).toBe(false);
      expect(existsSync(dirname(path))).toBe(false);
    } finally {
      await c.close();
      // Remove this test's files even when a cleanup mutation correctly fails.
      if (path.length > 0) {
        if (existsSync(path)) unlinkSync(path);
        if (existsSync(dirname(path))) rmdirSync(dirname(path));
      }
    }
  });
});
