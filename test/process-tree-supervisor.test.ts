import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessTreeError, launchProvider, prepareProcessTree, supervisorPath, windowsApprovalAdapter } from '../src/process-tree.js';

/** Test owned copies only: installed bytes are immutable and failures never compile replacements. */
let directory: string, executable: string;
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
beforeEach(async () => {
  if (process.platform !== 'win32') return;
  directory = mkdtempSync(join(tmpdir(), 'prism-supervisor-'));
  executable = join(directory, 'host-supervisor.exe');
  copyFileSync(supervisorPath(), executable);
  await prepareProcessTree({ executable });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (process.platform !== 'win32') return;
  await prepareProcessTree({ executable: supervisorPath() });
  rmSync(directory, { recursive: true, force: true });
});
async function runOnce(): Promise<number | null> {
  const provider = launchProvider(process.execPath, ['-e', 'process.exit(5)'], { cwd: directory, env: process.env });
  provider.child.stdout?.resume(); provider.child.stderr?.resume();
  return new Promise(resolve => provider.child.once('close', code => resolve(code)));
}

describe.runIf(process.platform === 'win32')('the shipped Windows supervisor', () => {
  it('uses the selected immutable executable without a generated cache or pointer', async () => {
    const before = sha256(executable);
    expect(windowsApprovalAdapter()).toBe(executable);
    await prepareProcessTree(); expect(await runOnce()).toBe(5);
    expect(sha256(executable)).toBe(before);
    expect(readdirSync(directory)).toEqual(['host-supervisor.exe']);
  });
  it('refuses altered program bytes without rebuilding or starting an uncontained provider', () => {
    const bytes = readFileSync(executable); bytes[bytes.length - 1] ^= 1; writeFileSync(executable, bytes);
    const changed = sha256(executable);
    expect(() => launchProvider(process.execPath, ['-e', 'process.exit(5)'], { cwd: directory, env: process.env })).toThrow(ProcessTreeError);
    expect(() => windowsApprovalAdapter()).toThrow(/does not match/);
    expect(sha256(executable)).toBe(changed); expect(readdirSync(directory)).toEqual(['host-supervisor.exe']);
  });
  it('prepares without consulting a compiler or starting a shell', async () => {
    const command = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw Error('no compiler or shell permitted'); });
    await prepareProcessTree({ executable }); expect(windowsApprovalAdapter()).toBe(executable);
    expect(command).not.toHaveBeenCalled();
  });
  it('refuses a missing selected executable and fences every launch until explicitly repaired', async () => {
    await expect(prepareProcessTree({ executable: join(directory, 'quarantined.exe') })).rejects.toThrow(/unavailable/);
    expect(() => windowsApprovalAdapter()).toThrow(/configured supervisor was refused/);
    expect(() => launchProvider(process.execPath, [], { cwd: directory, env: process.env })).toThrow(ProcessTreeError);
    expect(existsSync(join(directory, 'quarantined.exe'))).toBe(false);
    await prepareProcessTree({ executable }); expect(await runOnce()).toBe(5);
  });
  it.each(['../../outside.exe', 'x'.repeat(129), 'A'.repeat(64)])('a legacy pointer cannot select executable code (%s)', async value => {
    writeFileSync(join(directory, 'prism-acp-supervisor.current.sha256'), value);
    await prepareProcessTree({ directory });
    expect(windowsApprovalAdapter()).toBe(executable); expect(await runOnce()).toBe(5);
    expect(readFileSync(join(directory, 'prism-acp-supervisor.current.sha256'), 'utf8')).toBe(value);
  });
});
