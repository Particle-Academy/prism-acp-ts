import { describe, expect, it } from 'vitest';
import { launchProvider } from '../src/process-tree.js';
import { ClaudeDriver } from '../src/claude/driver.js';
import { apiKeyHome } from '../src/credentials.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SUPERVISOR_CS } from '../src/process-tree-supervisor-cs.js';

const base = { cwd: process.cwd(), env: {} };
describe('process transport validation before launch', () => {
  it('keeps supervisor diagnostics independent of bootstrap Console streams', () => {
    expect(SUPERVISOR_CS).not.toMatch(/\bConsole\s*\./);
  });
  it.runIf(process.platform !== 'win32')('explicitly rejects LOCAL mode on other platforms', () => {
    expect(() => launchProvider('must-never-run', [], { ...base, windowsStdio: 'local-pipes' })).toThrow('requires Windows');
  });
  it.runIf(process.platform === 'win32')('also supports opt-in LOCAL mode outside an AppContainer', async () => {
    const provider = launchProvider(process.execPath, ['--version'], { ...base, env: process.env, windowsStdio: 'local-pipes' });
    let output = '';
    provider.io!.stdout.on('data', bytes => { output += String(bytes); });
    provider.io!.stderr.resume();
    await provider.started;
    await provider.closed;
    expect(provider.child.exitCode).toBe(0);
    expect(output.trim()).toBe(process.version);
    expect(await provider.stop({ graceMs: 0 })).toMatchObject({ empty: true, verified: true, survivors: 0 });
  }, 20_000);
  it.each([0, -1, 60_001, Infinity, NaN, 1.5])('rejects invalid startup deadline %s', startupTimeoutMs => {
    expect(() => launchProvider('must-never-run', [], { ...base, startupTimeoutMs })).toThrow('startupTimeoutMs');
  });
  it.each([0, -1, 60_001, Infinity, NaN, 1.5])('rejects invalid I/O deadline %s', ioTimeoutMs => {
    expect(() => launchProvider('must-never-run', [], { ...base, ioTimeoutMs })).toThrow('ioTimeoutMs');
  });
  it('does not silently ignore LOCAL-only deadlines on the ordinary path', () => {
    expect(() => launchProvider('must-never-run', [], { ...base, startupTimeoutMs: 100 })).toThrow('requires local-pipe');
    expect(() => launchProvider('must-never-run', [], { ...base, ioTimeoutMs: 100 })).toThrow('requires local-pipe');
  });
  it('refuses generated Claude hooks/config before the incompatible ACL helper can run', () => {
    const processTree = { windowsStdio: 'local-pipes' as const };
    expect(() => new ClaudeDriver({ cwd: base.cwd, processTree, permissionPrompts: { tools: ['Bash'] } })).toThrow('does not support generated');
    expect(() => new ClaudeDriver({ cwd: base.cwd, processTree, mcpServers: [{ name: 'owned', command: process.execPath, args: [], env: [] }] })).toThrow('does not support generated');
  });
  it('requires LOCAL-mode API-key homes to be provisioned without invoking OS helpers', () => {
    const home = join(tmpdir(), 'prism-owned-never-created-' + randomUUID());
    expect(() => apiKeyHome('codex', { mode: 'apiKey', home, apiKey: 'owned-test-key' }, {}, { windowsStdio: 'local-pipes' })).toThrow('must already exist');
    expect(existsSync(home)).toBe(false);
  });
});
