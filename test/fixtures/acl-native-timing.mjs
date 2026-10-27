// Temporary hosted measurement harness. No production implementation is replaced.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
export const timingEnabled = process.env.PRISM_ACP_ACL_TIMING === '1';
export function measureAcl(sample, body) {
  if (!timingEnabled) return body();
  const original = childProcess.execFileSync;
  const calls = [];
  const started = performance.now();
  let passed = false;
  childProcess.execFileSync = function(command, args, options) {
    const name = path.basename(String(command)).toLowerCase();
    const operation = name === 'icacls.exe' ? args.includes('/reset') ? 'acl-reset' : args.includes('/inheritance:r') ? 'acl-owner-grant' : 'acl-planted-grant' : name === 'whoami.exe' ? 'identity' : name === 'powershell.exe' ? 'acl-read' : 'other';
    const at = performance.now();
    let exit = 0, timedOut = false;
    try { return original(command, args, { ...options, timeout: options?.timeout ?? 30000 }); }
    catch (error) { exit = typeof error.status === 'number' ? error.status : null; timedOut = error.code === 'ETIMEDOUT'; throw error; }
    finally { calls.push({ ordinal: calls.length + 1, executable: name, operation, milliseconds: performance.now() - at, exit, timedOut }); }
  };
  syncBuiltinESMExports();
  try { const result = body(); passed = true; return result; }
  finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    const receipt = { sample, passed, milliseconds: performance.now() - started, calls, node: process.version, platform: process.platform, commit: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, measurementOnlyTestBudgetMs: 120000, nativeCallLimitMs: 30000 };
    const directory = path.resolve('.acl-timing-evidence');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `sample-${String(sample).padStart(2, '0')}.json`), JSON.stringify(receipt, null, 2) + '\n');
    console.info(JSON.stringify({ aclTiming: receipt }));
  }
}
