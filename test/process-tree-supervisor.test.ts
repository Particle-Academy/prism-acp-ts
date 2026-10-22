import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProcessTreeError, launchProvider, prepareProcessTree } from '../src/process-tree.js';

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
const executable = join(directory, 'prism-acp-supervisor.exe');
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function runOnce(): Promise<number | null> {
  const provider = launchProvider(process.execPath, ['-e', 'process.exit(5)'], { cwd: directory, env: process.env });
  provider.child.stdout?.resume();
  provider.child.stderr?.resume();
  return new Promise((resolve) => provider.child.once('close', (code) => resolve(code)));
}

describe.runIf(process.platform === 'win32')('the Windows supervisor', () => {
  it('is built once into the given directory, with its hash recorded beside it', async () => {
    expect(existsSync(executable)).toBe(false);
    await prepareProcessTree({ directory });
    expect(existsSync(executable)).toBe(true);
    expect(readFileSync(`${executable}.sha256`, 'utf8').trim()).toBe(sha256(executable));
    const hash = sha256(executable);
    await prepareProcessTree();
    expect(sha256(executable)).toBe(hash);
    expect(await runOnce()).toBe(5);
  }, 60_000);

  it('an altered executable is not run: it is rebuilt, and the launch still works', async () => {
    appendFileSync(executable, 'tampered');
    const tampered = sha256(executable);
    expect(await runOnce()).toBe(5);
    expect(sha256(executable)).not.toBe(tampered);
    expect(readFileSync(`${executable}.sha256`, 'utf8').trim()).toBe(sha256(executable));
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
});
