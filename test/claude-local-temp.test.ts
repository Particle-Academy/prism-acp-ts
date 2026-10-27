import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver } from '../src/claude/driver.js';
import * as processTree from '../src/process-tree.js';

const temporary = realpathSync(tmpdir());
const roots: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/claude-restricted-provider.mjs', import.meta.url));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    const resolved = realpathSync(root);
    if (dirname(resolved) !== temporary || !basename(resolved).startsWith('prism-local-temp-')) throw new Error('owned temp fixture root changed');
    rmSync(resolved, { recursive: true, force: true });
  }
});

async function owned() {
  const root = mkdtempSync(join(temporary, 'prism-local-temp-')); roots.push(root);
  await processTree.prepareProcessTree({ directory: join(root, 'supervisor') });
  const marker = join(root, 'marker.json');
  const driver = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, 'pending', marker],
    nativeTools: 'none', processTree: { windowsStdio: 'local-pipes' },
    parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root },
  });
  return { root, marker, driver };
}

describe.runIf(process.platform === 'win32')('LOCAL restricted Claude effective host TEMP', () => {
  it('refuses a missing parent before invoking the native helper or provider, without revealing its path', async () => {
    const { root, driver } = await owned();
    const missing = join(root, 'owned-sensitive-parent');
    vi.stubEnv('TEMP', missing); vi.stubEnv('TMP', missing);
    const helper = vi.spyOn(processTree, 'createWindowsPrivateDirectory');
    const provider = vi.spyOn(processTree, 'launchProvider');
    let failure: unknown;
    try { driver.start(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(processTree.ProcessTreeError);
    expect((failure as Error).message).toContain('effective TEMP');
    expect((failure as Error).message).toContain('host must provision');
    expect((failure as Error).message).not.toContain(root);
    expect(helper).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
  }, 20_000);

  it.each(['present', 'retargeted-and-provisioned'])('uses a %s parent and removes the protected configuration on stop', async mode => {
    const { root, marker, driver } = await owned();
    const parent = mode === 'present' ? join(root, 'host-temp') : join(root, 'provider-home', 'Packages', 'owned-profile', 'AC', 'Temp');
    mkdirSync(parent, { recursive: true });
    vi.stubEnv('TEMP', parent); vi.stubEnv('TMP', parent);
    if (mode === 'retargeted-and-provisioned') {
      vi.stubEnv('HOME', join(root, 'provider-home'));
      vi.stubEnv('USERPROFILE', join(root, 'provider-home'));
      vi.stubEnv('LOCALAPPDATA', join(root, 'provider-home'));
    }
    const helper = vi.spyOn(processTree, 'createWindowsPrivateDirectory');
    let config: string | undefined;
    try {
      driver.start();
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 });
      config = (JSON.parse(readFileSync(marker, 'utf8')) as { config: string }).config;
      expect(dirname(dirname(config))).toBe(parent);
      expect(existsSync(config)).toBe(true);
      expect(helper).toHaveBeenCalledTimes(1);
    } finally {
      expect(await driver.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 });
    }
    expect(config).toBeDefined();
    expect(existsSync(config!)).toBe(false);
    expect(existsSync(dirname(config!))).toBe(false);
    expect(existsSync(parent)).toBe(true);
  }, 20_000);
});
