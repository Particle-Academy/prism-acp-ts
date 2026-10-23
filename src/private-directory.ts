import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { childEnv } from './env.js';

/**
 * Restrict a directory this process just created to the current user, BEFORE anything sensitive is written into it.
 * File modes mean nothing on Windows, so there inherited grants are removed and the current identity alone is granted
 * access; elsewhere the caller creates the directory with mode 0700 and this does nothing. Throws on failure, naming
 * no path.
 */
export function restrictToCurrentUser(directory: string): void {
  if (process.platform !== 'win32') return;
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const env = childEnv(process.env).env;
  const identity = execFileSync(join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true, env });
  const sid = identity.match(/\bS-\d+(?:-\d+)+\b/)?.[0];
  if (sid === undefined) throw new Error('cannot identify the Windows process identity');
  execFileSync(join(system32, 'icacls.exe'),
    [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
    { stdio: 'pipe', windowsHide: true, env });
}
