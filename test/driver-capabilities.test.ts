import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAUDE_DRIVER_CAPABILITIES, updatesFromFrames } from '../src/claude/driver.js';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import type { DriverFactory } from '../src/acp/agent.js';
import { serve } from '../src/acp/stdio.js';
import { encodeLine, NdjsonFramer } from '../src/ndjson.js';

function readLines(stream: PassThrough, frames: Record<string, unknown>[]): void {
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.length > 0) frames.push(JSON.parse(line) as Record<string, unknown>);
  });
}

describe('Claude driver capability declaration', () => {
  it('matches the permission-denied fixture on the ACP wire', async () => {
    // Captured from Claude Code 2.1.295; only the provider-generated call id is redacted.
    const fixture = readFileSync(
      fileURLToPath(new URL('./fixtures/claude-permission-denied.jsonl', import.meta.url)),
    );
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Record<string, unknown>[] = [];
    readLines(output, frames);
    const driverFactory: DriverFactory = (_options, events) => ({
      start() {},
      prompt() {
        const framer = new NdjsonFramer();
        const { updates } = updatesFromFrames(
          [...framer.push(fixture), ...framer.end()],
          new ClaudeToAcp(),
        );
        for (const update of updates) events.onUpdate?.(update);
        events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
      },
      endInput() {},
      kill() {},
      cliSessionId: null,
      withheldCredentials: [],
    });

    const served = serve({
      input,
      output,
      driverFactory,
      driverCapabilities: CLAUDE_DRIVER_CAPABILITIES,
    });
    input.write(encodeLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    input.write(encodeLine({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/work' } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const created = frames.find((frame) => frame.id === 2)?.result as Record<string, unknown>;
    input.write(
      encodeLine({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'write' }],
        },
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const permissionRequests = frames.filter((frame) => frame.method === 'session/request_permission');
    expect(CLAUDE_DRIVER_CAPABILITIES.permissionRequests).toBe(permissionRequests.length > 0);
    const updates = frames
      .map((frame) => (frame.params as Record<string, unknown> | undefined)?.update)
      .filter((update): update is Record<string, unknown> => typeof update === 'object' && update !== null);
    expect(updates.filter((update) => update.sessionUpdate === 'tool_call_update')).toHaveLength(1);
    input.destroy();
    await served.closed;
  });
});
