import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver } from '../src/claude/driver.js';
import { prepareProcessTree } from '../src/process-tree.js';

const roots: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/claude-restricted-provider.mjs', import.meta.url));
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = realpathSync(root);
    if (dirname(path) !== realpathSync(tmpdir()) || !basename(path).startsWith('prism-claude-policy-')) throw new Error('owned fixture root changed');
    rmSync(path, { recursive: true, force: true });
  }
});

async function session(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'prism-claude-policy-')); roots.push(root);
  mkdirSync(join(root, 'home'));
  await prepareProcessTree({ directory: join(root, 'supervisor') });
  const marker = join(root, 'marker.json');
  let finish!: () => void;
  const outcomes: unknown[] = [];
  const protocolErrors: string[] = [];
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const driver = new ClaudeDriver({
    cwd: root, binary: process.execPath, binaryArgs: [fixture, mode, marker], nativeTools: 'none',
    parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      LOCALAPPDATA: root, TEMP: root, TMP: root, CLAUDE_CONFIG_DIR: join(root, 'home'), ANTHROPIC_API_KEY: 'owned-inherited-key-must-be-withheld' },
  }, { onProtocolError: error => protocolErrors.push(error), onTurnEnd: outcome => { outcomes.push(outcome); finish(); } });
  driver.start();
  driver.prompt('owned fixture prompt');
  return { driver, marker, completed, outcomes, protocolErrors, root };
}

describe('restricted Claude startup before any user turn', () => {
  it.each(['unknown-version', 'missing-version', 'malformed', 'bad-frame', 'bad-message'])('refuses %s before delivering a queued prompt and cleans private config', async mode => {
    const { driver, marker } = await session(mode);
    try { await expect(driver.modelState()).rejects.toThrow(); }
    finally { expect(await driver.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 }); }
    const state = JSON.parse(readFileSync(marker, 'utf8')) as { prompts: number; config: string };
    expect(state.prompts).toBe(0);
    expect(existsSync(state.config)).toBe(false);
    expect(existsSync(dirname(state.config))).toBe(false);
  }, 20_000);

  it.each(['init-version', 'init-missing-tools', 'init-native', 'init-inherited', 'init-missing', 'init-session'])('refuses %s without publishing a successful turn', async mode => {
    const { driver, marker, completed, outcomes } = await session(mode);
    try {
      await driver.modelState();
      await completed;
      expect(outcomes).toEqual([expect.objectContaining({ stopReason: 'refusal', isError: true })]);
    } finally { expect(await driver.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 }); }
    const state = JSON.parse(readFileSync(marker, 'utf8'));
    expect(existsSync(dirname(state.config))).toBe(false);
  }, 20_000);

  it('bounds the startup queue and cancels its pending prompt without delivering it', async () => {
    const { driver, marker, outcomes, protocolErrors } = await session('pending');
    try {
      expect(() => driver.prompt('second queued prompt')).toThrow('only one pending prompt');
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      await driver.cancel();
      expect(outcomes).toEqual([expect.objectContaining({ stopReason: 'cancelled', isError: false })]);
    } finally { expect(await driver.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 }); }
    const state = JSON.parse(readFileSync(marker, 'utf8'));
    expect(state.prompts).toBe(0);
    expect(existsSync(state.config)).toBe(false);
    expect(existsSync(dirname(state.config))).toBe(false);
    expect(protocolErrors).toEqual([]);
  }, 20_000);

  it('stop discards the pending prompt and removes the generated configuration', async () => {
    const { driver, marker } = await session('pending');
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    expect(await driver.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 });
    const state = JSON.parse(readFileSync(marker, 'utf8'));
    expect(state.prompts).toBe(0);
    expect(existsSync(state.config)).toBe(false);
    expect(existsSync(dirname(state.config))).toBe(false);
  }, 20_000);

  it('releases a queued prompt only after the measured initialize response', async () => {
    const { driver, marker, completed, root } = await session('valid');
    try {
      await driver.modelState();
      await completed;
      driver.endInput();
    } finally { expect(await driver.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 }); }
    const state = JSON.parse(readFileSync(marker, 'utf8'));
    expect(state.prompts).toBe(1);
    expect(state.promptAfterInitialize).toBe(true);
    expect(state).toMatchObject({ home: root, profile: root, configHome: join(root, 'home'), inheritedKeyPresent: false });
    expect(driver.withheldCredentials).toContain('ANTHROPIC_API_KEY');
    expect(() => driver.prompt('after stop')).toThrow('has stopped');
    expect(existsSync(state.config)).toBe(false);
  }, 20_000);

  it('holds endInput until initialization releases the queued turn', async () => {
    const { driver, marker, completed } = await session('valid');
    try {
      driver.endInput();
      await driver.modelState();
      await completed;
    } finally { expect(await driver.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 }); }
    const state = JSON.parse(readFileSync(marker, 'utf8'));
    expect(state.prompts).toBe(1);
    expect(state.promptAfterInitialize).toBe(true);
    expect(existsSync(dirname(state.config))).toBe(false);
  }, 20_000);
});
