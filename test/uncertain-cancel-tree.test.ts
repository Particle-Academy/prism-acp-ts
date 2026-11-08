import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeDriver, ClaudeCancelStateError } from '../src/claude/driver.js';
import { CodexDriver } from '../src/codex/driver.js';
import type { StopVerdict } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/uncertain-cancel-cli.mjs', import.meta.url));
const unknownVerdict: StopVerdict = { graceful: false, empty: false, survivors: null, verified: false };
type Identity = { pid: number; start: string | null; state: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(ready: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) { if (Date.now() >= deadline) throw new Error('Owned native fixture deadline exceeded'); await sleep(20); }
}
function snapshot(pids: number[]): Identity[] {
  if (pids.length === 0) return [];
  if (process.platform === 'win32') {
    for (const pid of pids) expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const filter = pids.map(pid => 'ProcessId=' + pid).join(' OR ');
    const script = "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter '" + filter + "' -ErrorAction Stop | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId; start=$_.CreationDate.ToUniversalTime().Ticks.ToString(); state='running'} }); ConvertTo-Json -InputObject $rows -Compress";
    const result = spawnSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
    expect(result.status, 'Failed OS observation cannot mean processes died').toBe(0);
    const rows = JSON.parse(result.stdout.trim()) as Identity[];
    return pids.map(pid => rows.find(row => row.pid === pid) ?? { pid, start: null, state: 'gone' });
  }
  return pids.map(pid => {
    try {
      const raw = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      return { pid, start: fields[19], state: fields[0] === 'Z' ? 'zombie' : 'running' };
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return { pid, start: null, state: 'gone' };
      throw error;
    }
  });
}
const live = (before: Identity[], after: Identity[]) => before.filter(old => after.some(now => now.pid === old.pid && now.start === old.start && now.state === 'running'));
function parentEnv(directory: string): NodeJS.ProcessEnv {
  return { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, LOCALAPPDATA: directory, TEMP: directory, TMP: directory };
}
async function childrenReady(directory: string, driver: ClaudeDriver | CodexDriver): Promise<Identity[]> {
  const file = join(directory, 'descendants.jsonl');
  await until(() => {
    if (!existsSync(file) || !existsSync(join(directory, 'prompted'))) return false;
    const text = readFileSync(file, 'utf8');
    return text.endsWith('\n') && text.split('\n').filter(Boolean).length === 2;
  });
  const children = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pid: number; role: string });
  expect(children.map(child => child.role).sort()).toEqual(['grandchild', 'intermediate']);
  const pid = driver.processTree?.providerPid;
  expect(pid).toBeGreaterThan(0);
  const before = snapshot([pid!, ...children.map(child => child.pid)]);
  expect(before.every(row => row.state === 'running' && row.start !== null)).toBe(true);
  return before;
}
async function cleanup(driver: ClaudeDriver | CodexDriver, before: Identity[], directory: string): Promise<void> {
  try { await driver.stop({ graceMs: 0 }); }
  finally {
    // If an assertion fails, only matching owned PID + native start identities may be cleaned up.
    for (const row of live(before, snapshot(before.map(row => row.pid)))) {
      const now = snapshot([row.pid])[0];
      if (now.start === row.start && now.state === 'running') {
        try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
    // directory is the exact mkdtemp-owned root; never supplied by an external caller.
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!['win32', 'linux'].includes(process.platform))('uncertain cancellation through native supervised process trees', () => {
  it.each(['rejection', 'mismatch', 'timeout', 'exited-root'])('Claude %s exposes one final verdict and honest throw-time snapshots', async mode => {
    const directory = mkdtempSync(join(tmpdir(), 'prism-acp-cancel-native-'));
    const verdicts: StopVerdict[] = [];
    let uncertain = false;
    let early: unknown;
    let atFinalObservation: unknown;
    let driver!: ClaudeDriver;
    const events = {
      onProtocolError: (problem: string) => {
        if (problem !== 'cancel state uncertain; driver stopped') return;
        uncertain = true;
        try { driver.prompt('must refuse immediately'); } catch (error) { early = error; }
      },
      onStopVerdict: (verdict: StopVerdict) => {
        verdicts.push(verdict);
        try { driver.prompt('must already expose final facts'); } catch (error) { atFinalObservation = error; }
        if (mode === 'mismatch') throw new Error('owned observer failure');
      },
    };
    driver = new ClaudeDriver({ cwd: directory, binary: process.execPath, binaryArgs: [fixture, 'claude', mode, directory], settingSources: [], parentEnv: parentEnv(directory) }, events);
    let before: Identity[] = [];
    try {
      driver.start(); await driver.modelState(); driver.prompt('owned long-running tool');
      before = await childrenReady(directory, driver);
      await driver.cancel(); await until(() => uncertain, 45_000);
      // Observe automatic cleanup before invoking explicit stop ourselves. This
      // would fail if the uncertainty path bypassed the driver's public wrapper.
      await until(() => verdicts.length === 1);
      const result = await driver.stop({ graceMs: 0 });
      const after = snapshot(before.map(row => row.pid));
      expect(live(before, after)).toEqual([]);
      console.log(JSON.stringify({ family: 'claude', mode, platform: process.platform, before, after, verdict: result }));
      expect(result).toMatchObject({ empty: true, survivors: 0, verified: true });
      expect(verdicts).toEqual([result]);
      expect((atFinalObservation as ClaudeCancelStateError).stopVerdict).toEqual(result);
      expect(early).toBeInstanceOf(ClaudeCancelStateError);
      expect((early as ClaudeCancelStateError & { stopVerdict?: StopVerdict }).stopVerdict).toEqual(unknownVerdict);
      let later: unknown;
      try { driver.prompt('must refuse after cleanup'); } catch (error) { later = error; }
      expect((later as ClaudeCancelStateError & { stopVerdict?: StopVerdict }).stopVerdict).toEqual(result);
      // The early error stays a snapshot, and a consumer cannot mutate cached truth through it or the observer.
      expect((early as ClaudeCancelStateError & { stopVerdict?: StopVerdict }).stopVerdict).toEqual(unknownVerdict);
      expect(Object.isFrozen(verdicts[0])).toBe(true);
      expect(await driver.stop({ graceMs: 100 })).toEqual(result);
      expect(verdicts).toHaveLength(1);
    } finally { await cleanup(driver, before, directory); }
  }, 75_000);

  it.each(['refusal', 'no-reply', 'exited-root'])('Codex %s preserves its interrupt contract and observes explicit native stop', async mode => {
    const directory = mkdtempSync(join(tmpdir(), 'prism-acp-cancel-native-'));
    const verdicts: StopVerdict[] = [];
    let exits = 0;
    const driver = new CodexDriver({ cwd: directory, binary: process.execPath, binaryArgs: [fixture, 'codex', mode, directory], parentEnv: parentEnv(directory) }, { onExit: () => { exits++; }, onStopVerdict: (verdict: StopVerdict) => verdicts.push(verdict) });
    let before: Identity[] = [];
    try {
      driver.start(); await driver.modelState(); driver.prompt('owned long-running tool');
      before = await childrenReady(directory, driver);
      if (mode === 'refusal') {
        await expect(driver.cancel()).rejects.toThrow();
        expect(live(before, snapshot(before.map(row => row.pid)))).toHaveLength(3);
        expect(verdicts).toHaveLength(0);
      } else if (mode === 'no-reply') {
        let settled = false;
        const cancel = Promise.resolve(driver.cancel()).then(() => { settled = true; }, () => { settled = true; });
        await sleep(100);
        expect(settled).toBe(false); expect(verdicts).toHaveLength(0);
        const stopping = driver.stop({ graceMs: 0 }); await cancel;
        await stopping;
      } else { await driver.cancel(); await until(() => exits > 0); }
      const result = await driver.stop({ graceMs: 0 });
      const after = snapshot(before.map(row => row.pid));
      expect(live(before, after)).toEqual([]);
      console.log(JSON.stringify({ family: 'codex', mode, platform: process.platform, before, after, verdict: result }));
      expect(verdicts).toEqual([result]);
      expect(result.empty).toBe(true);
      // Native root-exit reporting races with explicit stop: preserve whichever
      // facts the supervisor actually reports. A separate custom-transport control
      // below fixes the empty:true/verified:false case and forbids promoting it.
      if (result.verified) expect(result.survivors).toBe(0);
      else expect(result.survivors).toBeNull();
      expect(await driver.stop()).toEqual(result); expect(verdicts).toHaveLength(1);
    } finally { await cleanup(driver, before, directory); }
  }, 45_000);
});
