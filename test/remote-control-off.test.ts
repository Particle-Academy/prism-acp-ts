import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver, CodexDriver, claudeArgs, encodeLine, listModels, type ClaudeDriverOptions, type McpServer } from '../src/index.js';
import { StdioCodexTransport } from '../src/codex/transport.js';
import { guardRemoteControl } from '../src/codex/driver.js';
import { RemoteControlRefused, assertNotRemoteControlFrame } from '../src/remote-control.js';

/**
 * REMOTE CONTROL IS FORCED OFF (G-319, Wish: "remote chat needs to be forced off").
 *
 * Claude: every launch carries `disableRemoteControl: true` through `--settings`, the documented per-launch switch
 * (https://code.claude.com/docs/en/settings-reference#disableremotecontrol), merged into whatever settings the launch
 * already passes and applied last. Codex: off by construction -- no remote-control flag or subcommand in the argv, and a
 * `remoteControl/*` RPC is refused before it is written.
 *
 * The question these ask is "what can still turn it on?", not "what did we send?": a host option that could carry a
 * second `--settings`, a padded flag, a settings file that drops the key.
 */

vi.mock('node:child_process', async () => ({ ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawn: vi.fn() }));
vi.mock('../src/process-tree.js', async () => ({
  ...await vi.importActual<typeof import('../src/process-tree.js')>('../src/process-tree.js'),
  launchProvider: (await import('./fake-launch.js')).fakeLaunch,
}));

/** A Claude stand-in that answers the control `initialize` with one model. */
class ClaudeChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); exitCode: number | null = null;
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const frame = JSON.parse(line);
        if (frame.type === 'control_request') queueMicrotask(() => this.stdout.write(encodeLine({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [{ value: 'fixture', displayName: 'Fixture' }] } } })));
      }
    });
    queueMicrotask(() => this.emit('spawn'));
  }
  kill(): boolean { this.exitCode = 0; this.emit('close', 0, null); return true; }
}

interface Launch { argv: string[]; env: Record<string, string>; settings: Record<string, unknown> }
const launches: Launch[] = [];
const drivers: ClaudeDriver[] = [];
beforeEach(() => {
  launches.length = 0;
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(((_binary: string, argv: readonly string[], options: { env: Record<string, string> }) => {
    const args = [...argv];
    const value = args[args.indexOf('--settings') + 1]!;
    // Inline JSON, or the path of the driver's private file: read it while it exists (it is removed at exit).
    const settings = JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(value, 'utf8')) as Record<string, unknown>;
    launches.push({ argv: args, env: options.env, settings });
    return new ClaudeChild() as unknown as ChildProcess;
  }) as never);
});
afterEach(() => { for (const driver of drivers.splice(0)) driver.kill(); });

const server = (): McpServer => ({ type: 'http', name: 'supplied', url: 'https://example.test/mcp', headers: [] });
const settingsOf = (argv: readonly string[]): string[] => argv.flatMap((arg, index) => (arg === '--settings' ? [argv[index + 1]!] : []));

function launch(options: Partial<ClaudeDriverOptions>): Launch {
  const driver = new ClaudeDriver({ cwd: process.cwd(), ...options } as ClaudeDriverOptions);
  drivers.push(driver);
  driver.start();
  expect(launches).toHaveLength(1);
  return launches[0]!;
}

// Every launch path the driver has: default, resume, a model, settings sources, restricted mode, approval hooks, a
// selective MCP deny, and the approval hook and the deny together.
const PATHS: Array<[string, Partial<ClaudeDriverOptions>]> = [
  ['default', {}],
  ['resume', { resumeSessionId: '11111111-1111-4111-8111-111111111111' }],
  ['model and permission mode', { model: 'sonnet', permissionMode: 'acceptEdits' }],
  ['no file-based setting sources', { settingSources: [], strictMcpConfig: true }],
  ['restricted (nativeTools none)', { nativeTools: 'none' }],
  ['supplied MCP servers', { mcpServers: [server()] }],
  ['selective MCP deny', { disabledMcpServers: ['tynn'] }],
  ...(process.platform === 'win32' ? [] : [['approval hooks', { permissionPrompts: { tools: ['Bash'] } }] as [string, Partial<ClaudeDriverOptions>]]),
  ...(process.platform === 'win32' ? [] : [['approval hooks and MCP deny', { permissionPrompts: { tools: ['Bash'] }, disabledMcpServers: ['tynn'] }] as [string, Partial<ClaudeDriverOptions>]]),
];

describe('Claude: disableRemoteControl on every launch path', () => {
  it.each(PATHS)('%s: exactly one --settings, carrying disableRemoteControl: true', (_name, options) => {
    const { argv, settings } = launch(options);
    expect(settingsOf(argv)).toHaveLength(1);
    expect(settings.disableRemoteControl).toBe(true);
  });

  it('keeps the host settings value beside it in the private settings file', () => {
    const { settings } = launch({ disabledMcpServers: ['tynn'] });
    expect(settings).toEqual({ deniedMcpServers: [{ serverName: 'tynn' }], disableRemoteControl: true });
  });

  it.runIf(process.platform !== 'win32')('keeps the approval hook beside it', () => {
    const { settings } = launch({ permissionPrompts: { tools: ['Bash'] }, disabledMcpServers: ['tynn'] });
    expect(settings.disableRemoteControl).toBe(true);
    expect((settings.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1);
    expect(settings.deniedMcpServers).toEqual([{ serverName: 'tynn' }]);
  });

  it('claudeArgs alone carries it inline when no settings file is given, across option combinations', () => {
    for (const options of [{}, { settingSources: [] as [] }, { model: 'haiku' }, { resumeSessionId: '11111111-1111-4111-8111-111111111111' }]) {
      const argv = claudeArgs({ cwd: '/w', ...options });
      expect(settingsOf(argv)).toEqual(['{"disableRemoteControl":true}']);
    }
    expect(settingsOf(claudeArgs({ cwd: '/w', nativeTools: 'none' }, '/owned/mcp.json'))).toEqual(['{"disableRemoteControl":true}']);
  });

  it('listModels launches the CLI with it too', async () => {
    const state = await listModels('claude', { binary: process.execPath, cwd: process.cwd(), timeoutMs: 5_000 });
    expect(state.availableModels.map((m) => m.modelId)).toEqual(['fixture']);
    expect(launches).toHaveLength(1);
    expect(settingsOf(launches[0]!.argv)).toHaveLength(1);
    expect(launches[0]!.settings.disableRemoteControl).toBe(true);
  });
});

describe('Claude: no host option removes it', () => {
  const padded = ['--settings', ' --settings', '--settings​', '--SETTINGS', '--settings={"disableRemoteControl":false}',
    '--remote-control', '--remote-control ', '﻿--remote-control', '--remote-control=name', 'remote-control', '--remote-control-session-name-prefix',
    '--cloud', '--remote', '--teleport'];
  it.each(padded)('binaryArgs carrying %j is refused before anything launches', (arg) => {
    expect(() => new ClaudeDriver({ cwd: process.cwd(), binary: process.execPath, binaryArgs: ['/abs/stub.mjs', arg] })).toThrow(RemoteControlRefused);
    expect(() => new ClaudeDriver({ cwd: process.cwd(), binaryArgs: [arg, '{"disableRemoteControl":false}'] })).toThrow(RemoteControlRefused);
    return expect(listModels('claude', { binaryArgs: [arg] })).rejects.toThrow(RemoteControlRefused).then(() => expect(launches).toHaveLength(0));
  });

  it('binaryArgs mutated after construction cannot add a second --settings', () => {
    const binaryArgs = ['/abs/stub.mjs'];
    const driver = new ClaudeDriver({ cwd: process.cwd(), binary: process.execPath, binaryArgs });
    drivers.push(driver);
    binaryArgs.push('--settings', '{"disableRemoteControl":false}');
    driver.start();
    expect(settingsOf(launches[0]!.argv)).toEqual(['{"disableRemoteControl":true}']);
  });

  it('an unknown option claiming to turn it off is ignored', () => {
    const { settings } = launch({ disableRemoteControl: false, settings: { disableRemoteControl: false } } as never);
    expect(settings.disableRemoteControl).toBe(true);
  });

  it('every other host option, set at once, still leaves it on', () => {
    const { settings, argv } = launch({ disabledMcpServers: ['tynn'], settingSources: ['user', 'project', 'local'], strictMcpConfig: true,
      model: 'sonnet', permissionMode: 'bypassPermissions', allowedTools: ['Read'], disallowedTools: ['Bash'], allowEnv: ['DISABLE_GROWTHBOOK'],
      parentEnv: { PATH: process.env.PATH, DISABLE_GROWTHBOOK: '0' }, disableFeatureFlags: false });
    expect(settingsOf(argv)).toHaveLength(1);
    expect(settings.disableRemoteControl).toBe(true);
  });
});

describe('Claude: the opt-in feature-flag env switch', () => {
  it('is off by default', () => {
    const { env } = launch({});
    expect(env.CLAUDE_CODE_DISABLE_FEATURE_FLAGS).toBeUndefined();
    expect(env.DISABLE_GROWTHBOOK).toBeUndefined();
  });

  it('sets CLAUDE_CODE_DISABLE_FEATURE_FLAGS=1 and its older name when asked, and keeps the setting', () => {
    const { env, settings } = launch({ disableFeatureFlags: true });
    expect(env.CLAUDE_CODE_DISABLE_FEATURE_FLAGS).toBe('1');
    expect(env.DISABLE_GROWTHBOOK).toBe('1');
    expect(settings.disableRemoteControl).toBe(true);
  });

  it('listModels honours it, and refuses it for Codex', async () => {
    await listModels('claude', { binary: process.execPath, cwd: process.cwd(), timeoutMs: 5_000, disableFeatureFlags: true });
    expect(launches[0]!.env.CLAUDE_CODE_DISABLE_FEATURE_FLAGS).toBe('1');
    await expect(listModels('codex', { disableFeatureFlags: true })).rejects.toThrow(/Claude option/);
  });

  it.each([1, 'true', null, {}])('refuses a non-boolean %j', (bad) => {
    expect(() => new ClaudeDriver({ cwd: process.cwd(), disableFeatureFlags: bad } as never)).toThrow(/disableFeatureFlags/);
  });
});

describe('Codex: remote control is off by construction', () => {
  it('the app-server argv has no remote flag or subcommand', async () => {
    const seen: string[][] = [];
    vi.mocked(spawn).mockImplementation(((_binary: string, argv: readonly string[]) => {
      seen.push([...argv]);
      return new ClaudeChild() as unknown as ChildProcess;
    }) as never);
    const transport = new StdioCodexTransport({ cwd: process.cwd(), env: {} }, { onFrame: () => {}, onStderr: () => {}, onProblem: () => {}, onExit: () => {} });
    await transport.start();
    transport.close();
    expect(seen).toEqual([['app-server', '--listen', 'stdio://']]);
    for (const arg of seen[0]!) expect(arg.toLowerCase()).not.toMatch(/remote|daemon|cloud/);
  });

  it.each(['--remote-control', ' --remote-control', 'remote-control', 'enable-remote-control', 'daemon', '--remote', 'cloud'])('binaryArgs carrying %j is refused', async (arg) => {
    expect(() => new CodexDriver({ cwd: process.cwd(), binaryArgs: [arg] })).toThrow(RemoteControlRefused);
    await expect(listModels('codex', { binaryArgs: [arg] })).rejects.toThrow(RemoteControlRefused);
    const transport = new StdioCodexTransport({ cwd: process.cwd(), env: {}, binaryArgs: [arg] }, { onFrame: () => {}, onStderr: () => {}, onProblem: () => {}, onExit: () => {} });
    await expect(transport.start()).rejects.toThrow(RemoteControlRefused);
  });

  const methods = ['remoteControl/enable', 'remoteControl/disable', 'remoteControl/status', ' remoteControl/enable', 'remotecontrol/enable', 'REMOTECONTROL/ENABLE', 'remote​Control/enable', 'remoteControl'];
  it.each(methods)('a %j frame is refused before it is written', (method) => {
    expect(() => assertNotRemoteControlFrame({ jsonrpc: '2.0', id: 1, method, params: {} })).toThrow(RemoteControlRefused);
    expect(() => assertNotRemoteControlFrame({ jsonrpc: '2.0', method })).toThrow(RemoteControlRefused);
    // The stdio transport refuses it before touching stdin (an unstarted transport would otherwise say "not open").
    const transport = new StdioCodexTransport({ cwd: process.cwd(), env: {} }, { onFrame: () => {}, onStderr: () => {}, onProblem: () => {}, onExit: () => {} });
    expect(() => transport.send({ jsonrpc: '2.0', id: 1, method })).toThrow(RemoteControlRefused);
  });

  it('ordinary requests and replies pass', () => {
    for (const frame of [{ jsonrpc: '2.0', id: 1, method: 'thread/start' }, { jsonrpc: '2.0', id: 1, result: { method: 'remoteControl/enable' } }, { method: 'remoteControlled/x' }]) {
      expect(() => assertNotRemoteControlFrame(frame)).not.toThrow();
    }
  });

  it('the guard the driver wraps every transport in refuses a remoteControl/* frame, writing nothing', () => {
    const written: unknown[] = [];
    const inner = { start: async () => {}, close: () => {}, send: (frame: unknown) => { written.push(frame); }, running: true };
    const guarded = guardRemoteControl(inner);
    expect(() => guarded.send({ jsonrpc: '2.0', id: 7, method: 'remoteControl/enable', params: {} })).toThrow(RemoteControlRefused);
    expect(written).toEqual([]);
    guarded.send({ jsonrpc: '2.0', id: 8, method: 'thread/start' });
    expect(written).toEqual([{ jsonrpc: '2.0', id: 8, method: 'thread/start' }]);
    expect(guarded.running).toBe(true);
  });

  it('a full driver startup sends no remote method', async () => {
    const written: unknown[] = [];
    const driver = new CodexDriver({ cwd: process.cwd() }, {}, (_launch, handlers) => ({
      start: async () => {}, close: () => {},
      send: (frame: unknown) => {
        written.push(frame);
        const value = frame as { id?: number; method?: string };
        if (value.id === undefined) return;
        const result = value.method === 'thread/start' ? { thread: { id: 'thread-1' } } : {};
        queueMicrotask(() => handlers.onFrame({ jsonrpc: '2.0', id: value.id, result }));
      },
    }));
    driver.start();
    await driver.ready;
    expect(written.map((frame) => (frame as { method?: string }).method)).toContain('thread/start');
    for (const frame of written) expect(String((frame as { method?: unknown }).method ?? '')).not.toMatch(/remote/i);
    driver.kill();
  });

  it('no source file names a remoteControl RPC or a remote-control launch except the refusal itself', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir)) { const path = join(dir, entry); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith('.ts')) files.push(path); } };
    walk(root);
    const offenders = files.filter((file) => !file.endsWith('remote-control.ts'))
      .filter((file) => /['"`]remoteControl\/|['"`]--remote-control|['"`]remote-control['"`]/i.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
