import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver, type ProblemDetail } from '../src/claude/driver.js';
import { MAX_LINE_BYTES, NdjsonFramer, encodeLine, parseLine } from '../src/ndjson.js';
import type { AcpUpdate } from '../src/claude/to-acp.js';

vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  spawn: vi.fn(),
}));

/**
 * MEASURED (Genie 2, 2026-10-14): a live Claude session showed `Broken · NDJSON frame exceeds 1000000 bytes
 * (1036723 bytes; content withheld)`. The frame was a tool result carrying an image the agent had just read. The
 * frame was dropped, so the result never reached the client, and the client took the report as fatal.
 *
 * Two fixes, both here:
 *   1. The cap bounds a RUNAWAY line; it must not refuse a provider's ordinary large frame.
 *   2. A framing problem drops ONE frame; the stream goes on. It is reported as recoverable, so a client can show it
 *      without calling the session dead.
 */

/** A valid JSON line of exactly `bytes` bytes (ASCII, so bytes = characters). */
function lineOf(bytes: number): string {
  const head = '{"type":"user","pad":"';
  const tail = '"}';
  return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
}

describe('the frame cap', () => {
  it('passes the measured 1,036,723-byte Claude frame', () => {
    const frame = parseLine(lineOf(1_036_723));
    expect(frame?.ok).toBe(true);
  });

  it('is 64,000,000 bytes, and a line over it is still refused by size', () => {
    expect(MAX_LINE_BYTES).toBe(64_000_000);
    const framer = new NdjsonFramer();
    const frames = framer.push(Buffer.from(`${lineOf(MAX_LINE_BYTES + 1)}\n`));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, error: { kind: 'oversize', bytes: MAX_LINE_BYTES + 1 } });
  });
});

class FakeClaude extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  readonly kill = vi.fn(() => true);
  constructor() {
    super();
    queueMicrotask(() => this.emit('spawn'));
  }
}

beforeEach(() => { vi.mocked(spawn).mockReset(); });

describe('a frame that cannot be read is reported as RECOVERABLE', () => {
  it('drops that one frame, says so with { recoverable: true }, and keeps mapping the stream after it', async () => {
    const child = new FakeClaude();
    vi.mocked(spawn).mockImplementation(() => child as unknown as ChildProcess);
    const problems: Array<{ problem: string; detail: ProblemDetail | undefined }> = [];
    const updates: AcpUpdate[] = [];
    const driver = new ClaudeDriver({ cwd: '/work', parentEnv: {} }, {
      onUpdate: (u) => updates.push(u),
      onProtocolError: (problem, detail) => problems.push({ problem, detail }),
    });
    driver.start();

    child.stdout.write('{"type": not json}\n');
    child.stdout.write(encodeLine({ type: 'system', subtype: 'init', session_id: '01a12564-30a8-7961-8aa9-6d145dd2e179' }));
    await new Promise((r) => setTimeout(r, 0));

    // COUNTED: one problem, recoverable, and the init AFTER it still mapped.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toEqual({ problem: expect.stringMatching(/not valid JSON/), detail: { recoverable: true } });
    expect(updates.filter((u) => u.sessionUpdate === 'notice')).toHaveLength(1);
    driver.kill();
  });

  it('POSITIVE CONTROL: a failure to spawn is NOT marked recoverable', async () => {
    const child = new FakeClaude();
    vi.mocked(spawn).mockImplementation(() => child as unknown as ChildProcess);
    const problems: Array<{ problem: string; detail: ProblemDetail | undefined }> = [];
    const driver = new ClaudeDriver({ cwd: '/work', parentEnv: {} }, {
      onProtocolError: (problem, detail) => problems.push({ problem, detail }),
    });
    driver.start();
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/failed to spawn/);
    expect(problems[0]?.detail?.recoverable ?? false).toBe(false);
    driver.kill();
  });
});
