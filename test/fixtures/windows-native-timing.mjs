// Temporary G150 diagnostics. Never records arguments, paths, identities or output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export const measuring = process.platform === 'win32' && process.env.PRISM_ACP_NATIVE_TIMING === '1';
let current;
const history = [];
function persist() {
  if (!current) return;
  const directory = resolve('.native-timing-evidence');
  mkdirSync(directory, { recursive: true });
  const variant = ['full-suite', 'cold', 'prewarmed', 'warmup'].includes(process.env.PRISM_ACP_NATIVE_VARIANT)
    ? process.env.PRISM_ACP_NATIVE_VARIANT : 'full-suite';
  const sample = Number(process.env.PRISM_ACP_NATIVE_SAMPLE ?? current.sample);
  if (!Number.isInteger(sample) || sample < 1 || sample > 30) throw new Error('Invalid timing sample');
  writeFileSync(join(directory, `${variant}-${sample}.json`), JSON.stringify({ ...current, variant, sample }, null, 2));
}
export function timedExecFileSync(original, command, args, options) {
  if (!measuring) return original(command, args, options);
  const executable = basename(String(command)).toLowerCase();
  const operation = executable === 'csc.exe' ? 'compile' : executable === 'whoami.exe' || executable === 'whoami' ? 'identity'
    : executable === 'icacls.exe' || executable === 'icacls' ? (args.includes('/reset') ? 'acl-reset' : 'acl-grant')
      : executable.includes('powershell') ? 'powershell' : 'other-native';
  const entry = { operation, ordinal: history.length + 1, milliseconds: 0, success: false, timeout: false };
  const start = performance.now();
  try {
    // Observation cap only; all production arguments, including existing shorter deadlines, are preserved.
    const value = original(command, args, { ...options, timeout: Math.min(options?.timeout ?? 30_000, 30_000) });
    entry.success = true;
    return value;
  } catch (error) {
    entry.timeout = error?.code === 'ETIMEDOUT';
    throw error;
  } finally {
    entry.milliseconds = performance.now() - start;
    history.push(entry);
    if (current) { current.calls.push(entry); persist(); }
  }
}
export function measureNativeCase(sample, body) {
  if (!measuring) return body();
  current = { sample, workerPid: process.pid, priorNativeCallsInFile: history.length, calls: [], success: false };
  const start = performance.now();
  try { const result = body(); current.success = true; return result; }
  finally { current.milliseconds = performance.now() - start; persist(); current = undefined; }
}
