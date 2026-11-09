import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { machine } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { launchProvider } from '../src/process-tree.js';

describe.runIf(process.platform === 'win32' && !!process.env.PRISM_ACP_SIGNED_SUPERVISOR_ROOT)('host-signed supervisor native execution', () => {
  it('accepts the genuinely signed host copy for stdio, LOCAL, approval and private-directory modes', async () => {
    const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'prism-supervisor-signed-'));
    const arch = /^(?:arm64|aarch64)$/i.test(machine()) ? 'arm64' : 'x64';
    const executable = join(process.env.PRISM_ACP_SIGNED_SUPERVISOR_ROOT!, arch + '-signed.exe');
    const worker = fileURLToPath(new URL('./fixtures/shipped-supervisor-worker.mjs', import.meta.url));
    const ready = join(root, 'ready'), go = join(root, 'go');
    const provider = launchProvider(process.execPath, [worker, root, ready, go, executable], { cwd: root, env: process.env });
    let output = ''; provider.child.stdout!.on('data', chunk => { output += String(chunk); }); provider.child.stderr!.resume();
    const closed = new Promise(resolve => provider.child.once('close', resolve));
    try {
      await provider.started;
      const deadline = Date.now() + 10000;
      while (!existsSync(ready)) { if (Date.now() > deadline) throw Error('owned signed worker readiness deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
      writeFileSync(go, 'go');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('owned signed worker completion deadline')), 30000); })]).finally(() => clearTimeout(timer));
      expect(exit, output).toBe(0);
      expect(JSON.parse(output.trim())).toMatchObject({ success: true, architecture: arch, compilerAttempts: 0, executableWrites: 0, privateDirectory: true, approval: { malformedExit: 2, allowExit: 0, denyExit: 2 } });
    } finally {
      expect(await provider.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 });
      if (dirname(realpathSync(root)) !== parent) throw Error('owned signed worker cleanup escaped temporary parent');
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 45000);
});
