/**
 * Claude turn cancel (issue #16), against a stand-in `claude` PROCESS: the driver spawns it, writes stream-json to its
 * stdin and reads stream-json back, so what is asserted is the bytes on the pipe and the process's survival -- not a
 * method call on a mock.
 *
 * The stand-in replays what the owner's real Claude Code did when measured on 2026-10-15
 * (scripts/probe-claude-interrupt.mjs): the `{ type: 'control_request', request_id, request: { subtype: 'interrupt' } }`
 * request was accepted, the interrupted turn ended with the result frame in
 * fixtures/claude-interrupted-result.json (error_during_execution / aborted_streaming, is_error true) 11 ms later,
 * the process stayed alive, and the next prompt ran to end_turn.
 *
 * POSIX only: the stand-in is a shebang script, which is how the driver can run it with claudeArgs() appended. CI and
 * the test machines are Linux.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDriver, CLAUDE_DRIVER_CAPABILITIES, type TurnOutcome } from '../src/claude/driver.js';
import { serve } from '../src/acp/stdio.js';
import { encodeLine } from '../src/ndjson.js';

const MEASURED_RESULT = readFileSync(
  fileURLToPath(new URL('./fixtures/claude-interrupted-result.json', import.meta.url)),
  'utf8',
).trim();

/** The stand-in CLI. Logs every stdin line to FAKE_CLAUDE_LOG; answers the way the measured CLI did. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const readline = require('node:readline');
const log = process.env.FAKE_CLAUDE_LOG;
const MEASURED_RESULT = ${JSON.stringify(MEASURED_RESULT)};
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
let initialized = false;
let inTurn = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(log, line + '\\n');
  const frame = JSON.parse(line);
  if (frame.type === 'user') {
    if (!initialized) {
      initialized = true;
      out({ type: 'system', subtype: 'init', session_id: '5b0c6a3e-2f4d-4c1b-9a7e-1d2c3b4a5f60' });
    }
    const text = frame.message.content.map((block) => block.text).join('');
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } } });
    if (text.includes('LIMIT-NO-EVENT')) {
      // tynn #791: the CLI ends the turn on a rate limit with NO rate_limit_event before it.
      out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_limit', content: [] }, error: 'rate_limit' });
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null });
    } else if (text.includes('PLAIN-ERROR')) {
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: null });
    } else if (text.includes('FINISH')) {
      out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', result: 'done' });
    } else if (text.includes('ABORT-UNASKED')) {
      // The measured frame with NO interrupt asked for: must stay an error turn.
      process.stdout.write(MEASURED_RESULT + '\\n');
    } else {
      inTurn = true;
    }
    return;
  }
  if (frame.type === 'control_request' && frame.request && frame.request.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: [] } } });
    if (inTurn) {
      inTurn = false;
      process.stdout.write(MEASURED_RESULT + '\\n');
    }
  }
});
`;

let dir: string;
let binary: string;
let logFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'prism-acp-fake-claude-'));
  binary = join(dir, 'claude');
  writeFileSync(binary, FAKE_CLAUDE);
  chmodSync(binary, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let runs = 0;
function freshLog(): string {
  runs += 1;
  logFile = join(dir, `stdin-${runs}.log`);
  writeFileSync(logFile, '');
  return logFile;
}

function stdinFrames(): Record<string, unknown>[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function until(what: string, ready: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function driverFor() {
  const turnEnds: TurnOutcome[] = [];
  const exits: unknown[] = [];
  const updates: unknown[] = [];
  const driver = new ClaudeDriver(
    { cwd: dir, binary, parentEnv: { ...process.env, FAKE_CLAUDE_LOG: freshLog() }, allowEnv: ['FAKE_CLAUDE_LOG'] },
    {
      onTurnEnd: (outcome) => turnEnds.push(outcome),
      onExit: (code, signal) => exits.push({ code, signal }),
      onUpdate: (update) => updates.push(update),
    },
  );
  return { driver, turnEnds, exits, updates };
}

describe.skipIf(process.platform === 'win32')('ClaudeDriver turn cancel, against a stand-in claude process', () => {
  it('declares cancel', () => {
    expect(CLAUDE_DRIVER_CAPABILITIES.cancel).toBe(true);
  });

  it('sends the measured interrupt, ends the turn cancelled, keeps the process, and runs the next prompt', async () => {
    const { driver, turnEnds, exits, updates } = driverFor();
    driver.start();
    try {
      driver.prompt('long task');
      await until('the turn to stream', () => updates.length > 0);

      await driver.cancel();
      await until('the interrupted turn to end', () => turnEnds.length === 1);

      const controls = stdinFrames().filter((frame) => frame.type === 'control_request');
      expect(controls).toHaveLength(1);
      expect(controls[0]).toEqual({
        type: 'control_request',
        request_id: expect.stringMatching(/\S/),
        // No `cancel_queued`: messages queued at the moment of Stop still run, which is what was measured.
        request: { subtype: 'interrupt' },
      });
      expect(turnEnds[0]).toEqual({ stopReason: 'cancelled', isError: false, raw: 'aborted_streaming' });
      expect(driver.running).toBe(true);
      expect(exits).toEqual([]);
      // The CLI's answer to our own request is consumed, not filed as an unmapped frame.
      expect(driver.unmapped.some((frame) => (frame as { type?: string }).type === 'control_response')).toBe(false);

      driver.prompt('FINISH please');
      await until('the next turn to end', () => turnEnds.length === 2);
      expect(turnEnds[1]).toMatchObject({ stopReason: 'end_turn', isError: false });
      expect(driver.running).toBe(true);
    } finally {
      driver.kill();
    }
  });

  it('is a no-op with no turn running: nothing written, nothing killed', async () => {
    const { driver, exits } = driverFor();
    driver.start();
    try {
      await until('the process to start', () => driver.running);
      await driver.cancel();
      driver.prompt('FINISH');
      await until('the turn to be logged', () => stdinFrames().length === 1);
      expect(stdinFrames().filter((frame) => frame.type === 'control_request')).toEqual([]);
      expect(exits).toEqual([]);
    } finally {
      driver.kill();
    }
  });

  it('leaves an abort it did NOT ask for as an error turn', async () => {
    const { driver, turnEnds } = driverFor();
    driver.start();
    try {
      driver.prompt('ABORT-UNASKED');
      await until('the turn to end', () => turnEnds.length === 1);
      expect(turnEnds[0]).toEqual({ stopReason: null, isError: true, raw: null });
    } finally {
      driver.kill();
    }
  });

  it('session/cancel over the ACP wire interrupts the turn instead of killing the CLI', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Record<string, unknown>[] = [];
    let pending = '';
    output.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.length > 0) frames.push(JSON.parse(line) as Record<string, unknown>);
    });
    const exits: unknown[] = [];
    const log = freshLog();
    const served = serve({
      input,
      output,
      driverCapabilities: CLAUDE_DRIVER_CAPABILITIES,
      driverFactory: (options, events) =>
        new ClaudeDriver(
          { cwd: dir, binary, parentEnv: { ...process.env, FAKE_CLAUDE_LOG: log }, allowEnv: ['FAKE_CLAUDE_LOG'] },
          { ...events, onExit: (code, signal) => { exits.push({ code, signal }); events.onExit?.(code, signal); } },
        ),
    });
    const reply = (id: number) => frames.find((frame) => frame.id === id);

    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    input.write(encodeLine({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } }));
    await until('session/new', () => reply(2) !== undefined);
    const sessionId = (reply(2)?.result as Record<string, unknown>).sessionId;

    input.write(encodeLine({
      jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'long task' }] },
    }));
    await until('the turn to stream', () => frames.some((frame) => frame.method === 'session/update'));
    input.write(encodeLine({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));
    await until('the cancelled prompt to be answered', () => reply(3) !== undefined);
    expect(reply(3)?.result).toEqual({ stopReason: 'cancelled' });
    expect(exits).toEqual([]);

    input.write(encodeLine({
      jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'FINISH' }] },
    }));
    await until('the next prompt to be answered', () => reply(4) !== undefined);
    expect(reply(4)?.result).toEqual({ stopReason: 'end_turn' });
    expect(exits).toEqual([]);

    // Control: closing the connection still stops the CLI.
    input.end();
    await served.closed;
    await until('the CLI to exit', () => exits.length === 1);
  });
});

describe.skipIf(process.platform === 'win32')('ClaudeDriver turn failure reason, against a stand-in claude process (tynn #791)', () => {
  it('a turn the CLI ends on rate_limit, with no rate_limit_event, carries the failure on its outcome', async () => {
    const { driver, turnEnds } = driverFor();
    driver.start();
    try {
      driver.prompt('LIMIT-NO-EVENT');
      await until('the failed turn to end', () => turnEnds.length === 1);
      expect(turnEnds[0]).toMatchObject({ isError: true, failure: { reason: 'rate_limit', kind: 'rate_limit' } });
      expect(turnEnds[0]?.failure?.resetsAtMs).toBeUndefined();
    } finally {
      driver.kill();
    }
  });

  it('the same failed turn without the field carries no failure (the control)', async () => {
    const { driver, turnEnds } = driverFor();
    driver.start();
    try {
      driver.prompt('PLAIN-ERROR');
      await until('the failed turn to end', () => turnEnds.length === 1);
      expect(turnEnds[0]?.isError).toBe(true);
      expect(turnEnds[0]?.failure).toBeUndefined();
    } finally {
      driver.kill();
    }
  });
});
