import childProcess from 'node:child_process';
import filesystem from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

export const compiledDigests = [];
export const compilerAttempts = [];
const realExecFileSync = childProcess.execFileSync;
const realRenameSync = filesystem.renameSync;
const pause = new Int32Array(new SharedArrayBuffer(4));
export const scheduleEvents = [];
let schedule;

// Only the first owned batch schedules two real publishers. No return value,
// executable, hash or error is fabricated; production module bytes stay exact.
export function configureColdSchedule(directory, cache, role) {
  if (!directory) return;
  if (!/^[0-7]$/.test(role) || dirname(resolve(directory)) !== dirname(resolve(cache))
      || basename(directory) !== 'coordination' || basename(cache) !== 'cache') throw Error('Invalid owned cold schedule');
  schedule = { directory, cache: resolve(cache), role: Number(role), compiled: false, published: false };
}
function mark(name) { filesystem.writeFileSync(join(schedule.directory, name), ''); }
function has(name) { return existsSync(join(schedule.directory, name)); }
function waitFor(test) {
  const until = Date.now() + 20_000;
  while (!test()) {
    if (Date.now() > until) throw Error('Owned cold publication barrier timed out');
    Atomics.wait(pause, 0, 0, 5);
  }
}
function afterCompile() {
  if (!schedule || schedule.compiled) return;
  schedule.compiled = true; scheduleEvents.push('compiled'); mark(`compiled-${schedule.role}`);
  if (schedule.role === 0) waitFor(() => has('compiled-1'));
  else if (schedule.role === 1) waitFor(() => has('published-0'));
  else waitFor(() => (has('prepared-0-ok') || has('prepared-0-failed')) && (has('prepared-1-ok') || has('prepared-1-failed')));
}
export function finishColdPreparation(success) {
  if (!schedule) return;
  scheduleEvents.push(success ? 'prepared-ok' : 'prepared-failed');
  mark(`prepared-${schedule.role}-${success ? 'ok' : 'failed'}`);
  if (schedule.role === 1) waitFor(() => has('prepared-0-ok') || has('prepared-0-failed'));
}
filesystem.renameSync = function (from, to, ...rest) {
  const result = realRenameSync.call(this, from, to, ...rest);
  if (schedule?.role === 0 && !schedule.published && dirname(resolve(String(to))) === schedule.cache
      && ['prism-acp-supervisor.exe', 'prism-acp-supervisor.current.sha256'].includes(basename(String(to)))) {
    schedule.published = true; scheduleEvents.push('published'); mark('published-0');
    waitFor(() => has('prepared-1-ok') || has('prepared-1-failed'));
    if (!has('prepared-1-ok')) throw Error('Owned second publisher did not verify its native generation');
    scheduleEvents.push('observed-peer-prepared');
  }
  return result;
};

// This module is loaded only in an owned measurement worker, before importing
// its producer copy. Forward every real invocation unchanged and observe the
// completed compiler output before the producer publishes it.
childProcess.execFileSync = function (command, args, ...rest) {
  const compiler = /(?:^|[\\/])csc[.]exe$/i.test(String(command));
  const output = compiler && Array.isArray(args) ? args.find((arg) => typeof arg === 'string' && arg.startsWith('-out:'))?.slice(5) : null;
  let result;
  try { result = realExecFileSync.call(this, command, args, ...rest); }
  catch (error) {
    if (output) compilerAttempts.push({ success: false, status: error.status ?? null });
    throw error;
  }
  if (output) {
    const hash = existsSync(output) ? createHash('sha256').update(readFileSync(output)).digest('hex') : null;
    compilerAttempts.push({ success: true, sha256: hash });
    if (hash) compiledDigests.push(hash);
    // A scheduling/observation failure must not be reported as a native compiler failure.
    afterCompile();
  }
  return result;
};
syncBuiltinESMExports();
