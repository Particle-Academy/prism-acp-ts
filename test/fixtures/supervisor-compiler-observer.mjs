import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

export const compiledDigests = [];
export const compilerAttempts = [];
const realExecFileSync = childProcess.execFileSync;

// This module is loaded only in an owned measurement worker, before importing
// its producer copy. Forward every real invocation unchanged and observe the
// completed compiler output before the producer publishes it.
childProcess.execFileSync = function (command, args, ...rest) {
  const compiler = /(?:^|[\\/])csc[.]exe$/i.test(String(command));
  const output = compiler && Array.isArray(args) ? args.find((arg) => typeof arg === 'string' && arg.startsWith('-out:'))?.slice(5) : null;
  try {
    const result = realExecFileSync.call(this, command, args, ...rest);
    if (output) {
      const hash = existsSync(output) ? createHash('sha256').update(readFileSync(output)).digest('hex') : null;
      compilerAttempts.push({ success: true, sha256: hash });
      if (hash) compiledDigests.push(hash);
    }
    return result;
  } catch (error) {
    if (output) compilerAttempts.push({ success: false, status: error.status ?? null });
    throw error;
  }
};
syncBuiltinESMExports();
