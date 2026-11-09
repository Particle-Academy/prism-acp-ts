import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { launchProvider, type ProviderProcess } from '../src/process-tree.js';

const worker = fileURLToPath(new URL('./fixtures/shipped-supervisor-worker.mjs', import.meta.url));
const assets = ['supervisor-manifest.json', 'win32-x64/prism-acp-supervisor.exe', 'win32-arm64/prism-acp-supervisor.exe'];
const hashes = () => assets.map(file => createHash('sha256').update(readFileSync(new URL('../native/' + file, import.meta.url))).digest('hex'));
async function until(check: () => boolean, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  while (!check()) { if (Date.now() > deadline) throw Error('owned shipped worker barrier deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
describe.runIf(process.platform === 'win32' && process.env.PRISM_ACP_SUPERVISOR_SHIPPED === '1')('shipped supervisor across independent processes', () => {
  it('runs 20x8 parallel first uses with zero compilation, executable writes, launch failures or survivors', async () => {
    const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'prism-supervisor-shipped-')), before = hashes();
    const rounds: unknown[] = [];
    try {
      for (let round = 0; round < 20; round++) {
        const cwd = join(root, 'round-' + round); mkdirSync(cwd);
        const go = join(cwd, 'go'), providers: ProviderProcess[] = [], output: string[] = [], closed: Promise<unknown>[] = [];
        try {
          for (let index = 0; index < 8; index++) {
            output[index] = '';
            const provider = launchProvider(process.execPath, [worker, cwd, join(cwd, 'ready-' + index), go], { cwd, env: process.env }); providers.push(provider);
            provider.child.stdout!.on('data', chunk => { output[index] += String(chunk); }); provider.child.stderr!.resume();
            closed.push(new Promise(resolve => provider.child.once('close', resolve)));
          }
          await Promise.all(providers.map(provider => provider.started));
          await until(() => providers.every((_, index) => existsSync(join(cwd, 'ready-' + index))), 15000); writeFileSync(go, 'go');
          let timer: ReturnType<typeof setTimeout> | undefined;
          const codes = await Promise.race([Promise.all(closed), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('owned workers completion deadline')), 60000); })]).finally(() => clearTimeout(timer));
          const rows = output.map(value => JSON.parse(value.trim()));
          expect(codes).toEqual(Array(8).fill(0)); expect(rows).toHaveLength(8);
          for (const row of rows) {
            expect(row).toMatchObject({ shippedWorker: true, success: true, compilerAttempts: 0, executableWrites: 0, privateDirectory: true, approval: { malformedExit: 2, allowExit: 0, denyExit: 2 } });
            expect(row.stops).toHaveLength(2); for (const stop of row.stops) expect(stop).toMatchObject({ empty: true, verified: true, survivors: 0 });
            expect(row.imageSha256).toMatch(/^[a-f0-9]{64}$/);
          }
          rounds.push({ round, workers: rows, exits: codes }); console.info(JSON.stringify({ shippedSupervisorBatch: rounds.at(-1) }));
        } finally {
          for (const provider of providers) expect(await provider.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 });
        }
      }
      expect(rounds).toHaveLength(20); expect(hashes()).toEqual(before);
      console.info(JSON.stringify({ shippedSupervisorSummary: { batches: 20, parallelism: 8, launches: 160, failed: 0, compilerAttempts: 0, executableWrites: 0, approvalVerified: 160, nativeStops: 320, osCachesPurged: false, immutableAssetHashes: before } }));
    } finally {
      if (dirname(realpathSync(root)) !== parent) throw Error('owned shipped worker cleanup escaped temporary parent');
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); expect(hashes()).toEqual(before);
    }
  }, 600000);
});
