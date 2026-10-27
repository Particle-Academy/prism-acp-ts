// Temporary G150 comparison. Fresh test workers; no CLI, auth, model or network access.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'win32') throw new Error('Windows measurement only');
const samples = Number(process.argv[2] ?? 30);
if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('Samples must be 1..30');
const root = mkdtempSync(join(tmpdir(), 'prism-g150-'));
const evidence = resolve('.native-timing-evidence');
mkdirSync(evidence, { recursive: true });
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const warmup = fileURLToPath(new URL('./warmup-windows-native-startup.mjs', import.meta.url));
const results = [];
try {
  for (let sample = 1; sample <= samples; sample++) {
    for (const variant of ['cold', 'prewarmed']) {
      const cache = join(root, `${variant}-${sample}`); mkdirSync(cache);
      const env = { ...process.env, LOCALAPPDATA: cache, PRISM_ACP_NATIVE_TIMING: '1', PRISM_ACP_NATIVE_VARIANT: variant, PRISM_ACP_NATIVE_SAMPLE: String(sample) };
      if (variant === 'prewarmed') {
        const prep = spawnSync(process.execPath, [warmup], { env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
        writeFileSync(join(evidence, `warmup-${sample}.log`), `${prep.stdout ?? ''}${prep.stderr ?? ''}`);
        if (prep.status !== 0) throw new Error(`Warmup failed at sample ${sample}`);
      }
      const run = spawnSync(process.execPath, [vitest, 'run', 'test/mcp-session-auth.test.ts', '-t', 'with hooks: writes one settings source', '--maxWorkers=1'], { env, encoding: 'utf8', timeout: 150_000, windowsHide: true });
      writeFileSync(join(evidence, `${variant}-${sample}.log`), `${run.stdout ?? ''}${run.stderr ?? ''}`);
      const measurement = JSON.parse(readFileSync(join(evidence, `${variant}-${sample}.json`), 'utf8'));
      results.push({ variant, sample, exitCode: run.status, ...measurement });
      console.log(JSON.stringify({ variant, sample, success: measurement.success, milliseconds: measurement.milliseconds, nativeCalls: measurement.calls.length }));
      if (run.status !== 0 || !measurement.success) throw new Error(`Case failed: ${variant} ${sample}`);
    }
  }
} finally {
  writeFileSync(join(evidence, 'fresh-worker-summary.json'), JSON.stringify(results, null, 2));
  const suffix = relative(tmpdir(), root);
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix) || !suffix.startsWith('prism-g150-')) throw new Error('Refusing unowned cleanup');
  rmSync(root, { recursive: true, force: true });
}
