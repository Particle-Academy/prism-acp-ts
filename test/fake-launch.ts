import { spawn } from 'node:child_process';
import type { LaunchOptions, ProcessTree, ProviderProcess } from '../src/process-tree.js';

/**
 * `launchProvider` without the supervisor: the provider spawned directly, with the arguments the driver built. For tests
 * that intercept `spawn` to check WHAT a driver sends its provider. Containment itself is tested against real
 * processes in process-tree.test.ts.
 */
export function fakeLaunch(command: string, args: readonly string[], options: LaunchOptions): ProviderProcess {
  const child = spawn(command, [...args], { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const tree: ProcessTree = { providerPid: child.pid ?? 0, supervisorPid: 0, containment: { kind: 'job-object' } };
  const started = new Promise<ProcessTree>((resolve, reject) => {
    child.once('spawn', () => resolve(tree));
    child.once('error', reject);
  });
  started.catch(() => {});
  return {
    child,
    started,
    tree,
    stop: async () => ({ graceful: false, empty: true, survivors: 0, verified: false }),
    kill: (signal) => { child.kill(signal); },
  };
}
