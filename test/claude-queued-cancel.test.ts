import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver, type TurnOutcome } from '../src/claude/driver.js';
import { ClaudeCancelStateError } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/claude-queued-cancel.mjs', import.meta.url));
const sessions: Awaited<ReturnType<typeof session>>[] = [];
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 8000;
  while (!ready()) { if (Date.now() > deadline) throw new Error('Controlled CLI did not reach the required condition'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
async function session(mode = 'queued', afterOutcome?: () => void, windowsStdio?: 'local-pipes', options: { protocolErrorListener?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prism-queued-cancel-'));
  const journal = join(root, 'wire.json');
  const outcomes: TurnOutcome[] = [], errors: string[] = [], text: string[] = [];
  let exited = false;
  const driver = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, mode, journal], ...(windowsStdio ? { processTree: { windowsStdio } } : {}), ...(mode === 'permission-fail' ? { permissionPrompts: { tools: ['Bash'] } } : {}),
    parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root } }, {
    onTurnEnd: value => { outcomes.push(value); afterOutcome?.(); }, ...(options.protocolErrorListener !== false ? { onProtocolError: (value: string) => errors.push(value) } : {}), onExit: () => { exited = true; },
    onUpdate: value => { if (value.sessionUpdate === 'agent_message_chunk') text.push(String((value.content as { text?: string }).text ?? '')); },
  });
  driver.start();
  const state = () => {
    const snapshot = readdirSync(journal + '.snapshots').filter(file => file.endsWith('.json')).sort().at(-1)!;
    return JSON.parse(readFileSync(join(journal + '.snapshots', snapshot), 'utf8')) as { users: { uuid?: string; text: string }[]; interrupts: { request: { cancel_queued?: boolean } }[] };
  };
  const result = { root, driver, outcomes, errors, text, state, exited: () => exited };
  sessions.push(result);
  await driver.modelState();
  return result;
}
afterEach(async () => {
  for (const s of sessions.splice(0)) {
    const verdict = await s.driver.stop({ graceMs: 100 });
    expect(verdict).toMatchObject({ empty: true, verified: true, survivors: 0 });
    const root = realpathSync(s.root);
    if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith('prism-queued-cancel-')) throw new Error('Owned fixture path changed');
    rmSync(root, { recursive: true });
  }
});
async function two(mode = 'queued') {
  const s = await session(mode);
  s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
  s.driver.prompt('SECOND'); await until(() => s.text.includes('READY-SECOND'));
  return s;
}

describe('ClaudeDriver UUID cancellation at the real prompt/cancel process entry', () => {
  it.each(['result', 'exit'] as const)('finishes %s without an optional onTurnEnd listener', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'prism-queued-no-listener-'));
    const built = new URL('../dist/index.js', import.meta.url).href;
    // A child watchdog is required: an event-loop spin also blocks the driver's own timers.
    const script = `
      import { ClaudeDriver } from ${JSON.stringify(built)};
      import { join } from 'node:path';
      const [fixture, root, mode] = process.argv.slice(1);
      let finish; const closed = new Promise(resolve => { finish = resolve; });
      let updates = 0;
      const driver = new ClaudeDriver({ cwd: root, binary: process.execPath,
        binaryArgs: [fixture, mode === 'exit' ? 'exit' : 'queued', join(root, 'wire.json')],
        parentEnv: process.env }, {
        onUpdate() { updates++; }, onExit(code) { finish(code); },
        onProtocolError() { throw new Error('controlled provider protocol error'); },
      });
      driver.start(); await driver.modelState();
      driver.prompt(mode === 'result' ? 'FINISH-one' : 'FIRST');
      if (mode === 'exit') driver.prompt('SECOND'); else driver.endInput();
      const code = await closed;
      const stop = await driver.stop({ graceMs: 0 });
      console.log(JSON.stringify({ code, updates: updates > 0, stop }));
    `;
    try {
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, fixture, root, mode], {
        cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 16000,
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root },
      });
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ code: mode === 'exit' ? 23 : 0, updates: true, stop: { verified: true, empty: true, survivors: 0 } });
    } finally {
      const owned = realpathSync(root);
      if (dirname(owned) !== realpathSync(tmpdir()) || !basename(owned).startsWith('prism-queued-no-listener-')) throw new Error('Owned fixture path changed');
      rmSync(owned, { recursive: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 20000);

  it('stamps fresh UUIDs without changing the user message', async () => {
    const s = await session();
    s.driver.prompt('FINISH-one'); await until(() => s.outcomes.length === 1);
    s.driver.prompt('FINISH-two'); await until(() => s.outcomes.length === 2);
    const users = s.state().users;
    for (const user of users) expect(user.uuid).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(users[0]?.uuid).not.toBe(users[1]?.uuid);
    expect(users.map(user => user.text)).toEqual(['FINISH-one', 'FINISH-two']);
  }, 20000);

  it('cancels queued UUIDs exactly once, keeps callback order, survives and accepts the next prompt', async () => {
    const s = await two();
    await s.driver.cancel(); await until(() => s.outcomes.length >= 2);
    expect(s.state().interrupts).toHaveLength(1);
    expect(s.state().interrupts[0]?.request).toEqual({ subtype: 'interrupt', cancel_queued: true });
    expect(s.outcomes).toEqual([
      { stopReason: 'cancelled', isError: false, raw: 'aborted_streaming' },
      { stopReason: 'cancelled', isError: false, raw: 'dropped by cancel' },
    ]);
    expect(s.driver.running).toBe(true);
    s.driver.prompt('NEXT'); await until(() => s.outcomes.length === 3);
    expect(s.outcomes[2]?.stopReason).toBe('end_turn');
    await s.driver.cancel();
    expect(s.state().interrupts).toHaveLength(1);
  }, 20000);

  it('consumes lifecycle frames without output, errors, content retention or extra completions', async () => {
    const s = await session('lifecycle-only');
    s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
    expect(s.outcomes).toEqual([]);
    expect(s.errors).toEqual([]);
    expect(JSON.stringify(s.driver.unmapped)).not.toContain('PRIVATE-LIFECYCLE-CONTENT');
    expect(JSON.stringify(s.text)).not.toContain('PRIVATE-LIFECYCLE-CONTENT');
    expect(s.driver.unmapped).toEqual([]);
    await s.driver.cancel(); await until(() => s.outcomes.length === 1);
    expect(s.outcomes[0]?.stopReason).toBe('cancelled');
  }, 20000);

  it('does not interrupt twice when cancel is called twice before the receipt', async () => {
    const s = await two();
    await Promise.all([s.driver.cancel(), s.driver.cancel()]);
    await until(() => s.outcomes.length >= 2);
    expect(s.outcomes).toHaveLength(2);
    expect(s.state().interrupts).toHaveLength(1);
  }, 20000);

  it('lets a queued prompt that became active finish through its own native result, including coalesced frames', async () => {
    const s = await two('active');
    await s.driver.cancel(); await until(() => s.outcomes.length >= 2);
    expect(s.outcomes).toEqual([
      { stopReason: 'end_turn', isError: false, raw: 'end_turn' },
      { stopReason: 'cancelled', isError: false, raw: 'aborted_streaming' },
    ]);
    await s.driver.cancel(); expect(s.state().interrupts).toHaveLength(1);
  }, 20000);

  it.each(['post', 'post-queued'])('keeps a %s prompt written after cancel but before the active result available for its own result', async mode => {
    const s = await two(mode);
    const cancelling = s.driver.cancel(); s.driver.prompt('POST'); await cancelling;
    await until(() => s.outcomes.length >= 3);
    expect(s.outcomes.map(outcome => outcome.stopReason)).toEqual(['cancelled', 'cancelled', 'end_turn']);
    expect(s.outcomes[1]?.raw).toBe('dropped by cancel');
    expect(s.outcomes[2]?.raw).toBe('end_turn');
    await s.driver.cancel(); expect(s.state().interrupts).toHaveLength(1);
  }, 20000);

  it.each(['foreign-receipt', 'under-count', 'still-queued', 'malformed', 'missing', 'overlap', 'duplicate-id'])('settles an inconsistent %s receipt with a distinct fixed marker and stops the uncertain process', async mode => {
    const s = await two(mode);
    await s.driver.cancel(); await until(() => s.outcomes.length >= 2);
    expect(s.outcomes).toHaveLength(2);
    expect(s.outcomes.every(outcome => outcome.stopReason === 'cancelled' && outcome.raw === 'cancel accounting mismatch')).toBe(true);
    expect(JSON.stringify(s.errors)).not.toMatch(/PRIVATE-|foreign-prompt-id/);
    expect(s.errors).toEqual(['cancel state uncertain; driver stopped']);
    expect(() => s.driver.prompt('NEXT')).toThrow(ClaudeCancelStateError);
    expect(() => s.driver.prompt('NEXT')).toThrow('cancel state uncertain; driver stopped');
    await until(s.exited);
    expect(s.outcomes).toHaveLength(2);
  }, 20000);

  it('does not let an unrelated result UUID finish the current prompt', async () => {
    const s = await session('foreign-result');
    s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
    expect(s.outcomes).toEqual([]);
    await s.driver.cancel(); await until(() => s.outcomes.length === 1);
    expect(s.outcomes[0]?.stopReason).toBe('cancelled');
  }, 20000);

  it('retains compatibility with an older CLI serial result that omits the UUID', async () => {
    const s = await session('legacy-serial');
    s.driver.prompt('FINISH'); await until(() => s.outcomes.length === 1);
    expect(s.outcomes[0]?.stopReason).toBe('end_turn');
  }, 20000);

  it('uses cancelled lifecycle metadata to corroborate an otherwise under-counted receipt, never to end a prompt alone', async () => {
    const s = await session('corroboration');
    s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
    expect(s.outcomes).toEqual([]);
    await s.driver.cancel(); await until(() => s.outcomes.length === 1);
    expect(s.outcomes[0]?.raw).toBe('cancel accounting mismatch');
  }, 20000);

  it('does not leave prompts waiting when the native interrupt receipt never arrives', async () => {
    const s = await two('no-receipt');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await s.driver.cancel();
      const end = Date.now() + 8000;
      while (s.state().interrupts.length === 0) { if (Date.now() > end) throw new Error('Interrupt not received'); await new Promise(resolve => setImmediate(resolve)); }
      expect(s.outcomes).toEqual([]);
      vi.advanceTimersByTime(30000);
      expect(s.outcomes).toHaveLength(2);
      expect(s.outcomes.every(outcome => outcome.raw === 'cancel accounting mismatch')).toBe(true);
    } finally { vi.useRealTimers(); }
    expect(() => s.driver.prompt('NEXT')).toThrow(ClaudeCancelStateError);
    await until(s.exited);
    expect(s.outcomes).toHaveLength(2);
  }, 20000);

  it('settles a post-cancel prompt too when a malformed receipt makes its disposition unknowable', async () => {
    const s = await two('malformed-post');
    const cancelling = s.driver.cancel(); s.driver.prompt('POST'); await cancelling;
    await until(() => s.outcomes.length >= 3);
    expect(s.outcomes).toHaveLength(3);
    expect(s.outcomes.every(outcome => outcome.raw === 'cancel accounting mismatch')).toBe(true);
    expect(s.errors).toEqual(['cancel state uncertain; driver stopped']);
    expect(() => s.driver.prompt('NEXT')).toThrow(ClaudeCancelStateError);
    await until(s.exited);
    expect(s.outcomes).toHaveLength(3);
  }, 20000);

  it('cancels a post-cancel prompt when its UUID is explicitly listed as dropped', async () => {
    const s = await two('post-drop');
    const cancelling = s.driver.cancel(); s.driver.prompt('POST'); await cancelling;
    await until(() => s.outcomes.length >= 3);
    expect(s.outcomes.map(outcome => outcome.raw)).toEqual(['aborted_streaming', 'dropped by cancel', 'dropped by cancel']);
    s.driver.prompt('NEXT'); await until(() => s.outcomes.length === 4);
    expect(s.outcomes[3]?.stopReason).toBe('end_turn');
    await s.driver.cancel(); expect(s.state().interrupts).toHaveLength(1);
  }, 20000);

  it('does not charge a prompt submitted from a completion callback to the cancelled queue', async () => {
    let afterOutcome = () => {};
    const s = await session('queued', () => afterOutcome());
    afterOutcome = () => { if (s.outcomes.length === 1) s.driver.prompt('NEXT'); };
    s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
    s.driver.prompt('SECOND'); await until(() => s.text.includes('READY-SECOND'));
    await s.driver.cancel(); await until(() => s.outcomes.length >= 3);
    expect(s.outcomes.map(outcome => outcome.raw)).toEqual(['aborted_streaming', 'dropped by cancel', 'end_turn']);
    await s.driver.cancel(); expect(s.state().interrupts).toHaveLength(1);
  }, 20000);

  it('settles and stops uncertain cancellation without an optional onProtocolError listener', async () => {
    const s = await session('malformed', undefined, undefined, { protocolErrorListener: false });
    s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
    s.driver.prompt('SECOND'); await until(() => s.text.includes('READY-SECOND'));
    await s.driver.cancel(); await until(() => s.outcomes.length === 2 && s.exited());
    expect(s.outcomes.map(outcome => outcome.raw)).toEqual(['cancel accounting mismatch', 'cancel accounting mismatch']);
    expect(() => s.driver.prompt('NEXT')).toThrow(ClaudeCancelStateError);
    expect(await s.driver.stop({ graceMs: 0 })).toMatchObject({ verified: true, empty: true, survivors: 0 });
  }, 20000);

  it('ends every unfinished prompt if the CLI exits without returning results', async () => {
    const s = await session('exit');
    s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
    s.driver.prompt('SECOND'); await until(() => s.exited());
    expect(s.outcomes).toEqual([
      { stopReason: null, isError: true, raw: 'Claude exited before prompt completion' },
      { stopReason: null, isError: true, raw: 'Claude exited before prompt completion' },
    ]);
    expect(() => s.driver.prompt('NEXT')).toThrow(/not started|closed/);
  }, 20000);

  it.skipIf(process.platform !== 'win32')('keeps UUID cancellation and the next turn correct on Windows local-pipe stdio', async () => {
    const s = await session('queued', undefined, 'local-pipes');
    s.driver.prompt('FIRST'); await until(() => s.text.includes('READY-FIRST'));
    s.driver.prompt('SECOND'); await until(() => s.text.includes('READY-SECOND'));
    await s.driver.cancel(); await until(() => s.outcomes.length >= 2);
    expect(s.outcomes.map(outcome => outcome.raw)).toEqual(['aborted_streaming', 'dropped by cancel']);
    s.driver.prompt('NEXT'); await until(() => s.outcomes.length === 3);
    expect(s.outcomes[2]?.stopReason).toBe('end_turn');
    await s.driver.cancel(); expect(s.state().interrupts).toHaveLength(1);
    expect(s.errors).toEqual([]);
  }, 20000);

  it('preserves an already settled queued cancellation if permission-hook validation subsequently fails', async () => {
    const s = await two('permission-fail');
    await s.driver.cancel(); await until(() => s.outcomes.length >= 2);
    expect(s.outcomes).toHaveLength(2);
    expect(s.outcomes[0]?.stopReason).toBe('refusal');
    expect(s.outcomes[1]?.raw).toBe('dropped by cancel');
    await until(s.exited);
    expect(s.outcomes).toHaveLength(2);
  }, 20000);
});
