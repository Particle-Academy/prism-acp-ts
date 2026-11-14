import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeDriver, coveredPromptsOf, type TurnOutcome } from '../src/claude/driver.js';

/**
 * G-266: a prompt the CLI FOLDS into the running turn must settle, from what the CLI reports, and say which turn it
 * joined. Driven through the real prompt()/cancel()/onTurnEnd entry Genie uses, against a process replaying the
 * Claude Code 2.1.325 measurement (fixtures/claude-fold.mjs; scripts/probe-claude-fold.mjs took it).
 */
const fixture = fileURLToPath(new URL('./fixtures/claude-fold.mjs', import.meta.url));
const sessions: { root: string; driver: ClaudeDriver }[] = [];
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 8000;
  while (!ready()) { if (Date.now() > deadline) throw new Error('Controlled CLI did not reach the required condition'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

async function session(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'prism-fold-'));
  const outcomes: TurnOutcome[] = [], errors: string[] = [], text: string[] = [];
  const driver = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, mode],
    parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root } }, {
    onTurnEnd: value => outcomes.push(value),
    onProtocolError: value => errors.push(value),
    onUpdate: value => { if (value.sessionUpdate === 'agent_message_chunk') text.push(String((value.content as { text?: string }).text ?? '')); },
  });
  driver.start();
  sessions.push({ root, driver });
  await driver.modelState();
  return { driver, outcomes, errors, text };
}

afterEach(async () => {
  for (const s of sessions.splice(0)) {
    const verdict = await s.driver.stop({ graceMs: 100 });
    expect(verdict).toMatchObject({ empty: true, verified: true, survivors: 0 });
    const root = realpathSync(s.root);
    if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('prism-fold-')) throw new Error('Owned fixture path changed');
    rmSync(root, { recursive: true });
  }
});

async function twoPrompts(mode: string) {
  const s = await session(mode);
  const first = s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
  const second = s.driver.prompt('SECOND');
  return { ...s, first, second };
}

describe('ClaudeDriver folded prompts (G-266)', () => {
  it('settles a folded prompt from the joined result, naming the turn it joined, and later turns still end', async () => {
    const s = await twoPrompts('fold');
    await until(() => s.outcomes.length === 2);
    expect(s.outcomes).toEqual([
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.first },
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.second, foldedInto: s.first },
    ]);
    // The bug was that every LATER turn end was held behind the folded prompt.
    const third = s.driver.prompt('THIRD');
    await until(() => s.outcomes.length === 3);
    expect(s.outcomes[2]).toEqual({ stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: third });
    expect(s.errors).toEqual([]);
  }, 20000);

  it('leaves a prompt that was not folded to its own result', async () => {
    const s = await twoPrompts('serial');
    await until(() => s.outcomes.length === 2);
    expect(s.outcomes).toEqual([
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.first },
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.second },
    ]);
    expect(s.errors).toEqual([]);
  }, 20000);

  it('cancels a turn with a prompt folded into it, keeps the CLI, and settles both as the joined turn', async () => {
    const s = await twoPrompts('fold-cancel');
    await until(() => s.text.includes('READY-SECOND'));
    await s.driver.cancel();
    await until(() => s.outcomes.length === 2);
    expect(s.outcomes).toEqual([
      { stopReason: 'cancelled', isError: false, raw: 'aborted_streaming', turnId: s.first },
      { stopReason: 'cancelled', isError: false, raw: 'aborted_streaming', turnId: s.second, foldedInto: s.first },
    ]);
    expect(s.errors).toEqual([]);
    expect(s.driver.running).toBe(true);
    const next = s.driver.prompt('NEXT');
    await until(() => s.outcomes.length === 3);
    expect(s.outcomes[2]).toEqual({ stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: next });
  }, 20000);

  it('fails closed when an interrupted result does not account for a started prompt', async () => {
    const s = await twoPrompts('fold-cancel-short');
    await until(() => s.text.includes('READY-SECOND'));
    await s.driver.cancel();
    await until(() => s.outcomes.length === 2);
    expect(s.outcomes).toEqual([
      { stopReason: 'cancelled', isError: false, raw: 'aborted_streaming', turnId: s.first },
      { stopReason: 'cancelled', isError: false, raw: 'cancel accounting mismatch', turnId: s.second },
    ]);
    expect(s.errors).toEqual(['cancel state uncertain; driver stopped']);
    expect(() => s.driver.prompt('AFTER')).toThrow();
  }, 20000);

  it('never lets a foreign id in the list consume a prompt', async () => {
    const s = await twoPrompts('foreign');
    await until(() => s.outcomes.length === 2);
    expect(s.outcomes).toEqual([
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.first },
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.second },
    ]);
    expect(s.errors).toEqual([]);
  }, 20000);

  it('reports a list that omits its own prompt, and folds nothing from it', async () => {
    const s = await twoPrompts('malformed');
    await until(() => s.outcomes.length === 2);
    expect(s.outcomes).toEqual([
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.first },
      { stopReason: 'end_turn', isError: false, raw: 'end_turn', turnId: s.second },
    ]);
    expect(s.errors).toEqual(['result user_message_uuids is malformed or omits its own prompt; folded prompts not settled']);
  }, 20000);
});

describe('coveredPromptsOf', () => {
  it('reads the measured list, and treats an absent or null one as nothing folded', () => {
    expect(coveredPromptsOf({ type: 'result', user_message_uuids: ['a', 'b'] }, 'a')).toEqual(['a', 'b']);
    expect(coveredPromptsOf({ type: 'result' }, 'a')).toEqual([]);
    expect(coveredPromptsOf({ type: 'result', user_message_uuids: null }, 'a')).toEqual([]);
  });

  it('refuses a list it cannot trust', () => {
    expect(coveredPromptsOf({ user_message_uuids: ['b'] }, 'a')).toBeNull();
    expect(coveredPromptsOf({ user_message_uuids: ['a', 'a'] }, 'a')).toBeNull();
    expect(coveredPromptsOf({ user_message_uuids: ['a', 7] }, 'a')).toBeNull();
    expect(coveredPromptsOf({ user_message_uuids: 'a' }, 'a')).toBeNull();
  });
});
