import childProcess from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { prepareProcessTree } from '../src/process-tree.js';

/** Warm native startup once, before worker/test clocks. The cold-install oracle explicitly opts out. */
export default async function setup(): Promise<void> {
  if (process.platform !== 'win32' || process.env.PRISM_ACP_SUPERVISOR_COLD === '1' || process.env.PRISM_ACP_HOOK_LATENCY === '1') return;
  const deadline = performance.now() + 120_000;
  const original = childProcess.execFileSync;
  let stage = 'supervisor preparation';
  let directory: string | undefined;
  let failure: Error | undefined;
  const remaining = (): number => {
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds <= 0) throw Object.assign(new Error('setup deadline exceeded'), { code: 'ETIMEDOUT' });
    return milliseconds;
  };

  // The production preparation uses synchronous csc. Bound that command as well as the ACL probe;
  // a timer alone cannot interrupt execFileSync. Restore builtins before any test worker starts.
  childProcess.execFileSync = ((command: string, args: readonly string[], options: any = {}) =>
    original(command, args, { ...options, timeout: Math.min(options.timeout || remaining(), remaining()) })) as typeof original;
  syncBuiltinESMExports();
  try {
    await prepareProcessTree();
    remaining();
    stage = 'PowerShell ACL startup';
    directory = mkdtempSync(join(tmpdir(), 'prism-acp-test-startup-'));
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'PSMODULEPATH') delete env[name];
    env.PRISM_ACP_TEST_ACL_DIRECTORY = directory;
    // Match the ACL assertions' .NET read; never load a PowerShell module or inspect another directory.
    childProcess.execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; [System.IO.Directory]::GetAccessControl($env:PRISM_ACP_TEST_ACL_DIRECTORY) | Out-Null'],
      { env, stdio: 'ignore', windowsHide: true });
    remaining();
  } catch (error) {
    const timedOut = (error as { code?: string }).code === 'ETIMEDOUT';
    failure = new Error(`Windows native test setup failed during ${stage}${timedOut ? ' (120-second deadline)' : ''}`);
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    if (directory !== undefined) {
      // Empty directory only: no recursive deletion or traversal into an unexpected child.
      try { rmdirSync(directory); }
      catch { failure = new Error(`${failure?.message ?? 'Windows native test setup failed'}; owned-directory cleanup failed`); }
    }
  }
  if (failure !== undefined) throw failure;
}
