import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { encodeLine } from '../src/ndjson.js';
import { META_CLI_SESSION_ID, META_RATE_LIMIT } from '../src/meta.js';
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
  it('completes turns and replays a resumed thread through ACP using the stored login', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prism-acp-live-codex-'));
    const marker = 'amber-river-481';
    const problems: string[] = [];
    const childEnvironments: Readonly<Record<string, string>>[] = [];

    function connect() {
      const input = new PassThrough();
      const output = new PassThrough();
      const received: Record<string, unknown>[] = [];
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
          childEnvironments.push(environment);
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
      return {
        request, received,
        close: async () => { await served.stopChildren(); input.end(); await served.closed; },
      };
    }

    const updatesOf = (messages: Record<string, unknown>[]) => messages
      .filter((message) => message.method === 'session/update')
      .map((message) => (message.params as { update: Record<string, unknown> }).update);
    const assistantText = (messages: Record<string, unknown>[]) => updatesOf(messages)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update.content as { text?: string })?.text ?? '').join('');
    const client = connect();
    let resumed: ReturnType<typeof connect> | undefined;

    try {
      const initialized = await client.request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect((initialized.result as Record<string, unknown>).protocolVersion).toBe(1);

      const opened = await client.request(2, 'session/new', { cwd });
      const sessionId = (opened.result as Record<string, unknown>).sessionId;
      expect(typeof sessionId).toBe('string');

      const firstStart = client.received.length;
      const prompted = await client.request(3, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: `Do not use tools. Remember this token for later: ${marker}. Reply with exactly the token.` }],
      });
      expect(prompted.error).toBeUndefined();

      expect(prompted.result).toMatchObject({ stopReason: 'end_turn' });
      expect(assistantText(client.received.slice(firstStart))).toContain(marker);

      const secondStart = client.received.length;
      const second = await client.request(4, 'session/prompt', {
        sessionId, prompt: [{ type: 'text', text: 'Do not use tools. Reply with only the token I asked you to remember.' }],
      });
      expect(second.error).toBeUndefined();
      expect(second.result).toMatchObject({ stopReason: 'end_turn' });
      expect(assistantText(client.received.slice(secondStart))).toContain(marker);

      const cliSessionId = updatesOf(client.received)
        .map((update) => (update._meta as Record<string, unknown> | undefined)?.[META_CLI_SESSION_ID])
        .find((id) => typeof id === 'string');
      expect(typeof cliSessionId).toBe('string');
      await client.close();

      resumed = connect();
      await resumed.request(5, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
      const loaded = await resumed.request(6, 'session/load', { sessionId: cliSessionId, cwd });
      expect(loaded.error).toBeUndefined();
      expect(assistantText(resumed.received)).toContain(marker); // history came back before any new prompt
      expect(updatesOf(resumed.received).some((update) => update.sessionUpdate === 'user_message_chunk')).toBe(true);
      expect(updatesOf(resumed.received).some((update) => update.sessionUpdate === 'session_message')).toBe(false);
      const thirdStart = resumed.received.length;
      const third = await resumed.request(7, 'session/prompt', {
        sessionId: cliSessionId,
        prompt: [{ type: 'text', text: 'Do not use tools. Reply with only the token I asked you to remember.' }],
      });
      expect(third.error).toBeUndefined();
      expect(third.result).toMatchObject({ stopReason: 'end_turn' });
      expect(assistantText(resumed.received.slice(thirdStart))).toContain(marker);
      expect(childEnvironments).toHaveLength(2);
      expect(updatesOf(client.received).some((update) =>
        (update._meta as Record<string, unknown> | undefined)?.[META_RATE_LIMIT] !== undefined)).toBe(true);
      for (const environment of childEnvironments) {
        expect(Object.keys(environment).some((name) => name.toUpperCase() === 'OPENAI_API_KEY')).toBe(false);
      }
      expect(problems).toEqual([]);
    } finally {
      await client.close();
      await resumed?.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 900_000);
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
