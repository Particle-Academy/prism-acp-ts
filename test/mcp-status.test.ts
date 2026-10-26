/**
 * MCP server status for a host (genie#1202): after a restart, Claude agents came up without a host's MCP tools
 * -- initialize took 9 s, tools/list got a 504 then a 429, and the CLI never retried.
 *
 * The fixtures below are MEASURED, not modelled (2026-10-26, sandbox/mcp-status in the envelope): a stdio MCP
 * server that answers initialize and then errors on tools/list, run under the real CLIs.
 *   - Claude Code 2.1.310, system/init:  { name: 'flaky', status: 'connected', source: 'dynamic' } and NO
 *     mcp__flaky__* tools. The healthy control: the same status and tools ['mcp__flaky__ping'].
 *     So `status` cannot tell them apart; `toolCount` can.
 *   - codex-cli 0.163.0, mcpServer/startupStatus/updated: starting -> failed (with the error) -> starting ->
 *     failed. mcpServerStatus/list scoped to the thread: runtimeStatus 'failed', no tools; the healthy control
 *     'connected' with tools { ping }. Unscoped, the list omitted the thread's server entirely.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver } from '../src/claude/driver.js';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import { CodexDriver, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { claudeMcpServers, codexListedReport, codexStartupReport } from '../src/mcp-status.js';
import { META_MCP_SERVERS } from '../src/meta.js';
import { encodeLine } from '../src/ndjson.js';

vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  spawn: vi.fn(),
}));
vi.mock('../src/process-tree.js', async () => ({
  ...await vi.importActual<typeof import('../src/process-tree.js')>('../src/process-tree.js'),
  launchProvider: (await import('./fake-launch.js')).fakeLaunch,
}));

const SESSION = '5b0c6a3e-2f4d-4c1b-9a7e-1d2c3b4a5f60';

/** Claude Code 2.1.310's init when the server's tools/list FAILED after initialize (measured). */
const CLAUDE_INIT_TOOLS_LIST_FAILED = {
  type: 'system', subtype: 'init', session_id: SESSION,
  mcp_servers: [{ name: 'flaky', status: 'connected', source: 'dynamic' }],
  tools: ['Bash', 'Read'],
};
/** The healthy control (measured). */
const CLAUDE_INIT_HEALTHY = {
  type: 'system', subtype: 'init', session_id: SESSION,
  mcp_servers: [{ name: 'flaky', status: 'connected', source: 'dynamic' }],
  tools: ['Bash', 'Read', 'mcp__flaky__ping'],
};

const meta = (update: Record<string, unknown>) => (update._meta as Record<string, unknown> | undefined)?.[META_MCP_SERVERS];

describe('Claude', () => {
  it('reports a server whose tools/list failed as connected with zero tools, which is what the CLI says', () => {
    expect(claudeMcpServers(CLAUDE_INIT_TOOLS_LIST_FAILED)).toEqual([{ name: 'flaky', status: 'connected', toolCount: 0 }]);
    expect(claudeMcpServers(CLAUDE_INIT_HEALTHY)).toEqual([{ name: 'flaky', status: 'connected', toolCount: 1 }]);
  });

  it('counts tools by the exact server prefix and keeps every documented status', () => {
    const reports = claudeMcpServers({
      mcp_servers: [
        { name: 'ty', status: 'connected' },
        { name: 'tynn', status: 'connected' },
        { name: 'auth', status: 'needs-auth' },
        { name: 'slow', status: 'pending' },
        { name: 'off', status: 'disabled' },
        { name: 'down', status: 'failed' },
      ],
      tools: ['mcp__tynn__send', 'mcp__tynn__read'],
    });

    expect(reports).toEqual([
      { name: 'ty', status: 'connected', toolCount: 0 },
      { name: 'tynn', status: 'connected', toolCount: 2 },
      { name: 'auth', status: 'needs-auth', toolCount: 0 },
      { name: 'slow', status: 'pending', toolCount: 0 },
      { name: 'off', status: 'disabled', toolCount: 0 },
      { name: 'down', status: 'failed', toolCount: 0 },
    ]);
  });

  it('never reads a status it does not know as connected', () => {
    expect(claudeMcpServers({ mcp_servers: [{ name: 'x', status: 'reconnecting' }], tools: [] }))
      .toEqual([{ name: 'x', status: 'failed', toolCount: 0, raw: 'reconnecting' }]);
    expect(claudeMcpServers({ tools: [] })).toBeUndefined();
  });

  it('puts the reports on the session-started notice', () => {
    const [notice] = new ClaudeToAcp().frame(CLAUDE_INIT_TOOLS_LIST_FAILED);

    expect(meta(notice as Record<string, unknown>)).toEqual([{ name: 'flaky', status: 'connected', toolCount: 0 }]);
  });

  describe('driver.mcpServers', () => {
    class ClaudeChild extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly exitCode = null;
      readonly kill = vi.fn(() => true);
      constructor() { super(); queueMicrotask(() => this.emit('spawn')); }
      frame(value: unknown): void { this.stdout.write(encodeLine(value)); }
    }

    beforeEach(() => { vi.mocked(spawn).mockReset(); });

    it('is null until init, then the init reports', async () => {
      const children: ClaudeChild[] = [];
      vi.mocked(spawn).mockImplementation(() => {
        const child = new ClaudeChild();
        children.push(child);
        return child as never;
      });
      const driver = new ClaudeDriver({ cwd: '/w', parentEnv: {} }, {});
      driver.start();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(driver.mcpServers).toBeNull();

      children[0].frame(CLAUDE_INIT_TOOLS_LIST_FAILED);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(driver.mcpServers).toEqual([{ name: 'flaky', status: 'connected', toolCount: 0 }]);
      driver.kill();
    });
  });
});

/** Codex: a fake app-server that replays the measured startup sequence and answers the scoped list. */
class McpTransport implements CodexTransport {
  readonly sent: Record<string, unknown>[] = [];
  readonly #handlers: CodexTransportHandlers;
  constructor(handlers: CodexTransportHandlers) { this.#handlers = handlers; }
  async start(): Promise<void> {}
  send(raw: unknown): void {
    const frame = raw as Record<string, unknown>;
    this.sent.push(frame);
    if (typeof frame.method !== 'string' || typeof frame.id !== 'number') return;
    const params = frame.params as Record<string, unknown> | undefined;
    let result: unknown = {};
    if (frame.method === 'thread/start') result = { thread: { id: 'thread-1' } };
    if (frame.method === 'account/rateLimits/read') result = { rateLimits: { primary: null, secondary: null } };
    if (frame.method === 'mcpServerStatus/list') {
      // Measured: only a THREAD-SCOPED list includes the thread's servers and their runtime status.
      result = params?.threadId === 'thread-1'
        ? { data: [
          { name: 'flaky', runtimeStatus: 'failed', authStatus: 'unsupported', tools: {} },
          { name: 'fancy-ui', runtimeStatus: 'connected', authStatus: 'unsupported', tools: { 'get-component': {}, 'list-nodes': {} } },
        ], nextCursor: null }
        : { data: [{ name: 'fancy-ui', runtimeStatus: null, authStatus: 'unsupported', tools: { 'get-component': {} } }], nextCursor: null };
    }
    queueMicrotask(() => this.#handlers.onFrame({ jsonrpc: '2.0', id: frame.id, result }));
  }
  close(): void {}
  frame(value: unknown): void { this.#handlers.onFrame(value); }
}

async function codex() {
  let transport!: McpTransport;
  const factory: CodexTransportFactory = (_o, handlers) => (transport = new McpTransport(handlers));
  const updates: Record<string, unknown>[] = [];
  const driver = new CodexDriver({ cwd: '/w', parentEnv: {} }, { onUpdate: (u) => updates.push(u as Record<string, unknown>) }, factory);
  driver.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { driver, transport, updates };
}

const startup = (name: string, status: string, error: string | null = null) => ({
  jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated',
  params: { threadId: 'thread-1', name, status, error, failureReason: null },
});
const ERROR = 'MCP client for `flaky` failed to start: MCP startup failed: Mcp error: -32603: Gateway Timeout (504)';

describe('Codex', () => {
  it('emits the full current list as each server starts, fails and retries (the measured sequence)', async () => {
    const { driver, transport, updates } = await codex();

    expect(driver.mcpServers).toBeNull();
    for (const frame of [
      startup('fancy-ui', 'starting'), startup('flaky', 'starting'),
      startup('flaky', 'failed', ERROR), startup('flaky', 'starting'), startup('flaky', 'failed', ERROR),
      startup('fancy-ui', 'ready'),
    ]) transport.frame(frame);

    const lists = updates.map(meta).filter((list) => list !== undefined);
    expect(lists).toHaveLength(6);
    expect(lists.at(-1)).toEqual([
      { name: 'fancy-ui', status: 'connected', toolCount: null, raw: 'ready' },
      { name: 'flaky', status: 'failed', toolCount: null, error: ERROR },
    ]);
    expect(driver.mcpServers).toEqual(lists.at(-1));
  });

  it('mcpServerStatus() asks for THIS thread and reports live status with tool counts', async () => {
    const { driver, transport } = await codex();

    await expect(driver.mcpServerStatus()).resolves.toEqual([
      { name: 'flaky', status: 'failed', toolCount: 0 },
      { name: 'fancy-ui', status: 'connected', toolCount: 2 },
    ]);
    const request = transport.sent.find((frame) => frame.method === 'mcpServerStatus/list');
    expect((request?.params as Record<string, unknown>).threadId).toBe('thread-1');
  });

  it('normalises every startup and runtime state, and marks re-authentication', () => {
    expect(['starting', 'ready', 'failed', 'cancelled'].map((status) => codexStartupReport({ name: 'x', status })?.status))
      .toEqual(['pending', 'connected', 'failed', 'failed']);
    expect(codexStartupReport({ name: 'x', status: 'failed', failureReason: 'reauthenticationRequired' })?.status).toBe('needs-auth');
    expect(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled', null]
      .map((runtimeStatus) => codexListedReport({ name: 'x', runtimeStatus })?.status))
      .toEqual(['pending', 'pending', 'connected', 'needs-auth', 'failed', 'failed', 'disabled', 'failed']);
  });
});
