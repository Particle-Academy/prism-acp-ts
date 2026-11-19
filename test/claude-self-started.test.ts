import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeDriver, type TurnOutcome } from '../src/claude/driver.js';
import type { AcpUpdate } from '../src/claude/to-acp.js';

/**
 * G-313: the Claude CLI sometimes runs a turn of its OWN -- a background task the agent started finishes after the
 * previous turn settled. Its result names none of our prompts, and was dropped, so no turn end, no usage, and a client
 * showing the turn running forever. Driven through the real prompt()/onTurnEnd entry against a process replaying that
 * shape (fixtures/claude-self-started.mjs).
 */
const fixture = fileURLToPath(new URL('./fixtures/claude-self-started.mjs', import.meta.url));
const sessions: { root: string; driver: ClaudeDriver }[] = [];
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 8000;
  while (!ready()) { if (Date.now() > deadline) throw new Error('Controlled CLI did not reach the required condition'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
const ended = (turnId: string) => ({ stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId });
const unsolicitedEnd = { stopReason: 'end_turn', isError: false, raw: 'end_turn', unsolicited: true, unsolicitedTurnId: expect.stringMatching(/^[a-f0-9-]{36}$/) };

async function session(mode = 'plain', resumeSessionId?: string) {
  const root = mkdtempSync(join(tmpdir(), 'prism-self-started-'));
  const outcomes: TurnOutcome[] = [], errors: string[] = [], text: string[] = [], updates: AcpUpdate[] = [];
  const driver = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, mode], ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root } }, {
    onTurnEnd: value => outcomes.push(value),
    onProtocolError: value => errors.push(value),
    onUpdate: value => {
      updates.push(value);
      if (value.sessionUpdate === 'agent_message_chunk') text.push(String((value.content as { text?: string }).text ?? ''));
    },
  });
  driver.start();
  sessions.push({ root, driver });
  await driver.modelState();
  return { driver, outcomes, errors, text, updates };
}

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    const verdict = await s.driver.stop({ graceMs: 100 });
    expect(verdict).toMatchObject({ empty: true, verified: true, survivors: 0 });
    const root = realpathSync(s.root);
    if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('prism-self-started-')) throw new Error('Owned fixture path changed');
    rmSync(root, { recursive: true });
  }
});

describe('ClaudeDriver turns the CLI starts itself (G-313)', () => {
  it('ends a background-task turn, maps its usage, and names no prompt of ours', async () => {
    const s = await session();
    const first = s.driver.prompt('BG');
    await until(() => s.outcomes.length === 2);
    expect(s.outcomes).toEqual([ended(first), unsolicitedEnd]);
    expect(s.outcomes[1]).not.toHaveProperty('turnId');
    expect(s.outcomes[1]).not.toHaveProperty('foldedInto');
    // The self-started turn's usage reaches the client, before its end.
    const usage = s.updates.filter(update => update.sessionUpdate === 'usage_update');
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({ used: 115, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
    expect(s.text).toContain('SELF-1');
    expect(s.errors).toEqual([]);
  }, 20000);

  it('settles a prompt folded into a self-started turn, naming that turn, and delivers the next turn end', async () => {
    const s = await session('fold');
    const first = s.driver.prompt('BG-HOLD');
    await until(() => s.text.includes('SELF-1'));
    const folded = s.driver.prompt('MIDWAY');
    await until(() => s.outcomes.length === 3);
    expect(s.outcomes).toEqual([
      ended(first),
      unsolicitedEnd,
      { ...ended(folded), foldedInto: s.outcomes[1]?.unsolicitedTurnId },
    ]);
    expect(s.outcomes[2]?.foldedInto).toEqual(expect.any(String));
    // The bug held every later turn end behind the folded prompt.
    const next = s.driver.prompt('NEXT');
    await until(() => s.outcomes.length === 4);
    expect(s.outcomes[3]).toEqual(ended(next));
    expect(s.errors).toEqual([]);
  }, 20000);

  it('ends a self-started turn and then a prompt queued behind it, in that order', async () => {
    const s = await session('queue');
    const first = s.driver.prompt('BG-HOLD');
    await until(() => s.text.includes('SELF-1'));
    const queued = s.driver.prompt('QUEUED');
    await until(() => s.outcomes.length === 3);
    expect(s.outcomes).toEqual([ended(first), unsolicitedEnd, ended(queued)]);
    expect(s.errors).toEqual([]);
  }, 20000);

  it('gives two ends for two consecutive self-started turns', async () => {
    const s = await session();
    const first = s.driver.prompt('BG2');
    await until(() => s.outcomes.length === 3);
    expect(s.outcomes).toEqual([ended(first), unsolicitedEnd, unsolicitedEnd]);
    expect(s.outcomes[1]?.unsolicitedTurnId).not.toBe(s.outcomes[2]?.unsolicitedTurnId);
    const next = s.driver.prompt('NEXT');
    await until(() => s.outcomes.length === 4);
    expect(s.outcomes[3]).toEqual(ended(next));
  }, 20000);

  it('drops a stray result that no live output preceded', async () => {
    const s = await session();
    const first = s.driver.prompt('STRAY');
    await until(() => s.outcomes.length === 1);
    await settle();
    const next = s.driver.prompt('NEXT');
    await until(() => s.outcomes.length === 2);
    await settle();
    expect(s.outcomes).toEqual([ended(first), ended(next)]);
    // The dropped result produced no usage either: one per turn of ours.
    expect(s.updates.filter(update => update.sessionUpdate === 'usage_update')).toHaveLength(2);
  }, 20000);

  it('keeps results replayed on resume dropped', async () => {
    const s = await session('plain', randomUUID());
    await settle();
    expect(s.outcomes).toEqual([]);
    const next = s.driver.prompt('NEXT');
    await until(() => s.outcomes.length === 1);
    await settle();
    expect(s.outcomes).toEqual([ended(next)]);
    expect(s.errors).toEqual([]);
  }, 20000);
});
