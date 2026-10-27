import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProcessTreeError, launchProvider, prepareProcessTree, windowsApprovalAdapter } from '../src/process-tree.js';

/**
 * THE WINDOWS SUPERVISOR IS BUILT ONCE AND CHECKED EVERY TIME (tynn, 2026-10-20): a freshly compiled, unsigned
 * executable is what antivirus quarantines, and csc.exe's presence must be checked, not assumed. It is built once per
 * install, its SHA-256 recorded, and verified before each launch; every failure names its cause, and none falls back
 * to an uncontained provider.
 *
 * Its own file: the directory override is process-wide.
 */
const directory = mkdtempSync(join(tmpdir(), 'prism-supervisor-'));
afterAll(() => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* a supervisor may still hold it */ } });
const pointer = join(directory, 'prism-acp-supervisor.current.sha256');
let executable: string;
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function runOnce(): Promise<number | null> {
  const provider = launchProvider(process.execPath, ['-e', 'process.exit(5)'], { cwd: directory, env: process.env });
  provider.child.stdout?.resume();
  provider.child.stderr?.resume();
  return new Promise((resolve) => provider.child.once('close', (code) => resolve(code)));
}

describe.runIf(process.platform === 'win32')('the Windows supervisor', () => {
  it('is built once into the given directory, with its hash recorded beside it', async () => {
    expect(existsSync(pointer)).toBe(false);
    await prepareProcessTree({ directory });
    executable = windowsApprovalAdapter();
    expect(existsSync(executable)).toBe(true);
    expect(readFileSync(pointer, 'utf8').trim()).toBe(sha256(executable));
    const hash = sha256(executable);
    expect(executable).toBe(join(directory, `prism-acp-supervisor-${hash}.exe`));
    await prepareProcessTree();
    expect(sha256(executable)).toBe(hash);
    expect(await runOnce()).toBe(5);
  }, 60_000);

  it('an altered executable is not run: it is rebuilt, and the launch still works', async () => {
    appendFileSync(executable, 'tampered');
    const tampered = sha256(executable);
    expect(await runOnce()).toBe(5);
    const replacement = windowsApprovalAdapter();
    expect(replacement).not.toBe(executable);
    expect(sha256(replacement)).not.toBe(tampered);
    expect(readFileSync(pointer, 'utf8').trim()).toBe(sha256(replacement));
  });

  it('no compiler is a ProcessTreeError naming the cause, never an uncontained provider', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'prism-supervisor-none-'));
    const saved = process.env.SystemRoot;
    // A Windows directory with no .NET Framework under it.
    process.env.SystemRoot = elsewhere;
    try {
      await prepareProcessTree({ directory: join(elsewhere, 'empty') });
      expect.unreachable('built without a compiler');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ProcessTreeError);
      expect((cause as Error).message).toMatch(/csc\.exe\) was not found/);
    } finally {
      process.env.SystemRoot = saved;
      await prepareProcessTree({ directory });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.each(['../../outside.exe','x'.repeat(129),'A'.repeat(64)])('an invalid current pointer cannot select an executable (%s)',async(value)=>{
    const unavailable=join(directory,'no-compiler');
    const previous=process.env.SystemRoot;
    writeFileSync(pointer,value);process.env.SystemRoot=unavailable;
    try{
      await expect(prepareProcessTree({directory})).rejects.toThrow(/csc\.exe/);
      expect(()=>windowsApprovalAdapter()).toThrow(/cannot prepare Claude approval adapter/);
    }finally{
      if(previous===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=previous;
      await prepareProcessTree({directory});
      expect(readFileSync(pointer,'utf8').trim()).toBe(sha256(windowsApprovalAdapter()));
    }
  });
});
