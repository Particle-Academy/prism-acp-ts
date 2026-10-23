/**
 * LIVE turn cancel against the real Codex App Server (issue #16). Opt-in: `npm run test:live` (PRISM_ACP_LIVE=1),
 * and it needs a signed-in Codex home. It skips, naming why, rather than passing when either is missing.
 *
 * What it measures, because the fakes can only assert what the docs promise:
 * - `turn/interrupt` is accepted and the turn ends with Codex's own status `interrupted` -- read from the raw
 *   outcome, not the ACP stop reason, because the ACP surface answers `cancelled` after any cancel and so could not
 *   tell an interrupted turn from one that simply finished first;
 * - the app-server is neither closed nor exited;
 * - the next prompt on the same thread runs to `end_turn`.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexDriver } from '../src/codex/driver.js';
import type { TurnOutcome } from '../src/claude/driver.js';
import type { AcpUpdate } from '../src/claude/to-acp.js';
import { StdioCodexTransport } from '../src/codex/transport.js';

const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const liveEnabled = process.env.PRISM_ACP_LIVE === '1';
const hasCodexHome = (() => {
  try {
    return statSync(codexHome).isDirectory();
  } catch {
    return false;
  }
})();
const skipReasons = [
  ...(!liveEnabled ? ['set PRISM_ACP_LIVE=1 to enable live child tests'] : []),
  ...(!hasCodexHome ? [`no Codex home found at ${codexHome}`] : []),
];
const skipReason = skipReasons.length > 0 ? ` [skipped: ${skipReasons.join('; ')}]` : '';

describe.skipIf(skipReasons.length > 0)(`Codex turn cancel, real child${skipReason}`, () => {
  it('interrupts the turn, keeps the app-server, and runs the next prompt', async () => {
    const turnEnds: TurnOutcome[] = [];
    const updates: AcpUpdate[] = [];
    const problems: string[] = [];
    const exits: unknown[] = [];
    const sent: Record<string, unknown>[] = [];
    let spawns = 0;
    let closes = 0;
    const cwd = mkdtempSync(join(tmpdir(), 'prism-acp-live-cancel-'));

    const driver = new CodexDriver(
      { cwd, parentEnv: process.env, allowEnv: ['CODEX_HOME'], approvalPolicy: 'never', sandbox: 'read-only' },
      {
        onTurnEnd: (outcome) => turnEnds.push(outcome),
        onUpdate: (update) => updates.push(update),
        onProtocolError: (problem) => problems.push(problem),
        onExit: (code, signal) => exits.push({ code, signal }),
      },
      (options, handlers) => {
        spawns += 1;
        const transport = new StdioCodexTransport(options, handlers);
        return {
          start: () => transport.start(),
          send: (frame: unknown) => {
            sent.push(frame as Record<string, unknown>);
            transport.send(frame);
          },
          close: (signal?: NodeJS.Signals) => {
            closes += 1;
            transport.close(signal);
          },
          stop: transport.stop.bind(transport),
          get processTree() { return transport.processTree; },
        };
      },
    );

    const until = async (what: string, ready: () => boolean, ms = 180_000) => {
      const deadline = Date.now() + ms;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    driver.start();
    try {
      await driver.ready;
      driver.prompt('Write the integers from 1 to 2000, one per line, with no other text. Do not use any tools.');
      // Cancel once the turn is visibly running, so there is a turn to interrupt rather than one not yet begun.
      await until('the first streamed output', () =>
        updates.some((u) => u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk'));
      await driver.cancel();
      await until('the cancelled turn to end', () => turnEnds.length >= 1, 60_000);

      expect(sent.filter((frame) => frame.method === 'turn/interrupt')).toHaveLength(1);
      expect(turnEnds[0]).toEqual({ stopReason: 'cancelled', isError: false, raw: 'interrupted' });
      expect(exits).toEqual([]);
      expect(closes).toBe(0);

      const nextStart = updates.length;
      driver.prompt('Do not use tools. Reply with exactly: ok');
      await until('the next turn to end', () => turnEnds.length >= 2);
      expect(turnEnds[1]).toMatchObject({ stopReason: 'end_turn', isError: false });
      expect(updates.slice(nextStart).filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => (update.content as { text?: string })?.text ?? '').join('')).toContain('ok');
      expect(spawns).toBe(1);
      expect(exits).toEqual([]);
      expect(problems).toEqual([]);
    } finally {
      const stopped = await driver.stop();
      expect(stopped).toMatchObject({ empty: true, survivors: 0, verified: true });
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 420_000);
});
