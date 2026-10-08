import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { encodeLine } from '../src/ndjson.js';
import { startLiveCodexHost } from './live-codex-host.js';

const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const hasCodexHome = isDirectory(codexHome);
const missing = preconditionSkipReasons(codexHome, hasCodexHome);
const liveEnabled = process.env.PRISM_ACP_LIVE === '1';

describe('Codex real-child preconditions', () => {
  it('omits a skip reason for a present home and names the path when absent', () => {
    const samplePath = '/home/runner/.codex';
    expect(preconditionSkipReasons(samplePath, true)).toEqual([]);
    expect(preconditionSkipReasons(samplePath, false)).toEqual([
      `no Codex home found at ${samplePath}`,
    ]);
    expect(missing.every((reason) => reason.includes(codexHome))).toBe(true);
  });
});

const skipReasons = [
  ...(!liveEnabled ? ['set PRISM_ACP_LIVE=1 to enable live child tests'] : []),
  ...missing,
];
const skipReason = skipReasons.length > 0 ? ` [skipped: ${skipReasons.join('; ')}]` : '';

describe.skipIf(!liveEnabled || missing.length > 0)(`Codex App Server real child${skipReason}`, () => {
  it('initializes and completes one turn through ACP without an API key in the child env', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: Record<string, unknown>[] = [];
    const problems: string[] = [];
    let childEnvironment: Readonly<Record<string, string>> | undefined;
    let buffer = '';

    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) received.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf('\n');
      }
    });

    const served = startLiveCodexHost({
      input,
      output,
      onProtocolError: (_sessionId, problem) => problems.push(problem),
      onSpawnEnvironment: (environment) => {
        childEnvironment = environment;
      },
    });

    async function request(id: number, method: string, params?: unknown) {
      input.write(encodeLine({ jsonrpc: '2.0', id, method, params }));
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const reply = received.find((message) => message.id === id);
        if (reply !== undefined) return reply;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no reply to ${method} within 300 seconds`);
    }

    try {
      const initialized = await request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect((initialized.result as Record<string, unknown>).protocolVersion).toBe(1);

      const opened = await request(2, 'session/new', { cwd: process.cwd() });
      const sessionId = (opened.result as Record<string, unknown>).sessionId;
      expect(typeof sessionId).toBe('string');

      const prompted = await request(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply with exactly: ok' }],
      });
      expect(prompted.error).toBeUndefined();

      const updates = received
        .filter((message) => message.method === 'session/update')
        .map((message) => (message.params as { update: Record<string, unknown> }).update);
      const stopReason = (prompted.result as Record<string, unknown> | undefined)?.stopReason;
      const turnEvidence = { stopReason, updateCount: updates.length };
      // A prompt that resolves with no completion and no updates did no useful visible work.
      const acceptable = stopReason === 'end_turn' || turnEvidence.updateCount > 0;
      expect({ ...turnEvidence, acceptable }).toEqual({ ...turnEvidence, acceptable: true });
      expect(childEnvironment).toBeDefined();
      expect('OPENAI_API_KEY' in (childEnvironment ?? {})).toBe(false);
      expect(problems).toEqual([]);
    } finally {
      input.end();
      await served.closed;
    }
  }, 360_000);
});

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function preconditionSkipReasons(path: string, exists: boolean): string[] {
  return exists ? [] : [`no Codex home found at ${path}`];
}
