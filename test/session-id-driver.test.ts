import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver, cliSessionIdOf } from '../src/claude/driver.js';
import { CodexDriver } from '../src/codex/driver.js';
import { META_CLI_SESSION_ID } from '../src/meta.js';
import { encodeLine } from '../src/ndjson.js';
import type { AcpUpdate } from '../src/claude/to-acp.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const UUID = '01a12564-30a8-7961-8aa9-6d145dd2e179';
const INVALID_IDS = [
  'a&echo PWNED', 'a|echo PIPED', 'a&&echo CHAINED', 'two words',
  'a\nb', 'a\n', 'a\r', 'a\tb', 'aé', 'aа', '', 'a'.repeat(129),
  '_leading', '.leading', ':leading', '-leading',
  ...['"', "'", '`', '<', '>', '^', '%', '!', '$', '(', ')', '/', '\\']
    .map((character) => `a${character}b`),
];
const VALID_IDS = [UUID, '123e4567-e89b-42d3-a456-426614174000', 'A', 'a'.repeat(128), 'a._:-Z9'];

/** Exercise both shipped drivers and Codex's real transport, intercepting only spawn. */
class ProviderChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  readonly sent: Record<string, unknown>[] = [];
  readonly kill = vi.fn(() => true);

  constructor(providerId: unknown) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trimEnd().split('\n')) {
        const request = JSON.parse(line) as Record<string, unknown>;
        this.sent.push(request);
        if (typeof request.id !== 'number') continue;
        const params = request.params as Record<string, unknown>;
        let result: unknown = {};
        if (request.method === 'thread/start') result = { thread: { id: providerId } };
        if (request.method === 'thread/resume') result = { thread: { id: params.threadId } };
        if (request.method === 'thread/turns/list') result = { data: [], nextCursor: null };
        queueMicrotask(() => this.frame({ jsonrpc: '2.0', id: request.id, result }));
      }
    });
    queueMicrotask(() => this.emit('spawn'));
  }

  frame(value: unknown): void {
    this.stdout.write(encodeLine(value));
  }
}

beforeEach(() => vi.mocked(spawn).mockReset());

for (const provider of ['claude', 'codex'] as const) {
  describe(`${provider} session id trust boundary`, () => {
    function setup(resumeSessionId?: string, providerId: unknown = UUID) {
      const children: ProviderChild[] = [];
      vi.mocked(spawn).mockImplementation(() => {
        const child = new ProviderChild(providerId);
        children.push(child);
        return child as unknown as ChildProcess;
      });
      const updates: AcpUpdate[] = [];
      const problems: string[] = [];
      const exits: unknown[] = [];
      const options = { cwd: '/work', parentEnv: {}, resumeSessionId };
      const events = {
        onUpdate: (update: AcpUpdate) => updates.push(update),
        onProtocolError: (problem: string) => problems.push(problem),
        onExit: (code: number | null) => exits.push(code),
      };
      const driver = provider === 'claude'
        ? new ClaudeDriver(options, events)
        : new CodexDriver(options, events);
      async function start() {
        driver.start();
        if (driver instanceof CodexDriver) await driver.ready;
      }
      function init(id?: unknown) {
        children[0].frame(provider === 'claude'
          ? { type: 'system', subtype: 'init', ...(id === undefined ? {} : { session_id: id }) }
          : { jsonrpc: '2.0', method: 'thread/started', params: { thread: id === undefined ? {} : { id } } });
      }
      return { driver, updates, problems, exits, children, start, init };
    }

    it.each(INVALID_IDS)('rejects provider id %j before persistence or later invocation', async (id) => {
      const state = setup(undefined, id);
      await state.start();
      if (provider === 'claude') state.init(id);
      expect(state.driver.cliSessionId).toBeNull();
      expect(state.updates.every((update) => !(META_CLI_SESSION_ID in (update._meta ?? {})))).toBe(true);
      expect(state.problems).toContainEqual(expect.stringMatching(
        provider === 'codex' && id === ''
          ? /Codex app-server startup failed \(Error\)/
          : /invalid (session_id|thread.id).*rejected/,
      ));
      expect(vi.mocked(spawn).mock.calls.every((call) => !(call[1] as string[]).includes(id))).toBe(true);
      // A consumer that returns the rejected provider value still cannot invoke it.
      state.driver.kill();
      const callCount = vi.mocked(spawn).mock.calls.length;
      const resumed = setup(id);
      await resumed.start();
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(callCount);
      expect(resumed.children).toHaveLength(0);
      expect(resumed.problems).toEqual(['invalid resumeSessionId: rejected CLI session id shape']);
    });

    it.each(VALID_IDS)('stores, emits and resumes valid provider id %j unchanged', async (id) => {
      const state = setup(undefined, id);
      await state.start();
      if (provider === 'claude') state.init(id);
      expect(state.driver.cliSessionId).toBe(id);
      expect(state.updates.filter((update) => META_CLI_SESSION_ID in (update._meta ?? {})))
        .toEqual([expect.objectContaining({ _meta: { [META_CLI_SESSION_ID]: id } })]);
      expect(state.problems).toEqual([]);
      state.driver.kill();

      const resumed = setup(id);
      await resumed.start();
      expect(resumed.children).toHaveLength(1);
      expect(resumed.problems).toEqual([]);
      if (provider === 'claude') {
        const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
        expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', id]);
      } else {
        expect(resumed.children[0].sent).toContainEqual(expect.objectContaining({
          method: 'thread/resume', params: expect.objectContaining({ threadId: id }),
        }));
      }
      resumed.driver.kill();
    });

    it.each(INVALID_IDS)('refuses client resume id %j before spawn', async (id) => {
      const state = setup(id);
      await state.start();
      expect(spawn).not.toHaveBeenCalled();
      expect(state.children).toHaveLength(0);
      expect(state.problems).toEqual(['invalid resumeSessionId: rejected CLI session id shape']);
      expect(state.exits).toEqual([1]);
      expect(() => state.driver.prompt('cannot invoke')).toThrow(/not started/);
    });

    it('accepts sess_123_456 from the provider and preserves the existing Codex ACP-id refusal', async () => {
      const id = 'sess_123_456';
      const state = setup(undefined, id);
      await state.start();
      if (provider === 'claude') state.init(id);
      expect(state.driver.cliSessionId).toBe(id);
      expect(state.updates).toContainEqual(expect.objectContaining({ _meta: { [META_CLI_SESSION_ID]: id } }));
      expect(state.problems).toEqual([]);
      state.driver.kill();
      const resumed = setup(id);
      await resumed.start();
      if (provider === 'claude') {
        expect(resumed.children).toHaveLength(1);
        expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toContain(id);
        expect(resumed.problems).toEqual([]);
        resumed.driver.kill();
      } else {
        expect(resumed.children).toHaveLength(0);
        expect(resumed.problems).toContainEqual(expect.stringContaining('ACP-minted session id'));
      }
    });

    it('distinguishes absent, valid and invalid notification ids without losing a valid id', async () => {
      const state = setup();
      await state.start();
      state.init();
      expect(state.problems).toEqual([]);
      state.init(UUID);
      const updateCount = state.updates.length;
      state.init('a&echo PWNED');
      state.init(123);
      expect(state.driver.cliSessionId).toBe(UUID);
      expect(state.problems).toHaveLength(2);
      expect(state.updates).toHaveLength(updateCount);
      state.driver.kill();
    });

    if (provider === 'codex') {
      it('preserves the startup failure and shutdown for an empty thread/start id', async () => {
        const state = setup(undefined, '');
        await state.start();
        expect(state.problems).toEqual([
          'Codex app-server startup failed (Error)',
        ]);
        expect(state.driver.cliSessionId).toBeNull();
        expect(state.children[0].kill).toHaveBeenCalledWith('SIGTERM');
        expect(state.children[0].sent.some((frame) => frame.method === 'account/rateLimits/read')).toBe(false);
        expect(() => state.driver.prompt('cannot continue startup')).toThrow(/has exited/);
      });
    }
  });
}

it('keeps cliSessionIdOf extraction distinct from validation', () => {
  expect(cliSessionIdOf({ type: 'system', subtype: 'init' })).toBeNull();
  expect(cliSessionIdOf({ type: 'system', subtype: 'init', session_id: 'a&echo PWNED' })).toBe('a&echo PWNED');
});
