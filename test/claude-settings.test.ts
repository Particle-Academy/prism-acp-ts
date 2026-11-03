import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeDriver, claudeArgs, type ClaudeDriverOptions } from '../src/claude/driver.js';

const options = (extra: Record<string, unknown> = {}) => ({ cwd: '.', ...extra }) as ClaudeDriverOptions;
const flagValue = (args: readonly string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

describe('Claude setting sources and strict MCP configuration', () => {
  it('keeps native defaults when the options are omitted or strict MCP is false', () => {
    expect(claudeArgs(options({ strictMcpConfig: false }))).toEqual(claudeArgs(options()));
    expect(claudeArgs(options())).not.toContain('--setting-sources');
    expect(claudeArgs(options())).not.toContain('--strict-mcp-config');
  });

  it.each([[], ['user'], ['project'], ['local'], ['user', 'project', 'local']].map(sources => ({ sources })))('passes explicit sources $sources, including an empty list', ({ sources }) => {
    const args = claudeArgs(options({ settingSources: sources }));
    expect(flagValue(args, '--setting-sources')).toBe(sources.join(','));
    expect(args.filter(arg => arg === '--setting-sources')).toHaveLength(1);
  });

  it('supports typed readonly sources and an independent strict MCP option', () => {
    const typed: ClaudeDriverOptions = { cwd: '.', settingSources: ['user'] as const, strictMcpConfig: true };
    const args = claudeArgs(typed, '/owned/mcp.json', '/owned/settings.json');
    expect(args).toContain('--strict-mcp-config');
    expect(flagValue(args, '--mcp-config')).toBe('/owned/mcp.json');
    expect(flagValue(args, '--settings')).toBe('/owned/settings.json');
    expect(flagValue(args, '--setting-sources')).toBe('user');
    const withoutServers = claudeArgs(options({ strictMcpConfig: true }));
    expect(withoutServers).toContain('--strict-mcp-config');
    expect(withoutServers).not.toContain('--mcp-config');
  });

  it.each([null, 'user', [''], ['User'], ['user,project'], ['project '], ['--settings'], [1], new Array(1), {}].map(bad => ({ bad })))('refuses malformed source configuration $bad before launch', ({ bad }) => {
    const malformed = options({ settingSources: bad });
    expect(() => claudeArgs(malformed)).toThrow(/settingSources/);
    expect(() => new ClaudeDriver(malformed)).toThrow(/settingSources/);
  });

  it.each([null, 1, 'true', [], {}].map(bad => ({ bad })))('refuses a non-boolean strict MCP option $bad before launch', ({ bad }) => {
    const malformed = options({ strictMcpConfig: bad });
    expect(() => claudeArgs(malformed)).toThrow(/strictMcpConfig/);
    expect(() => new ClaudeDriver(malformed)).toThrow(/strictMcpConfig/);
  });

  it('keeps nativeTools none stricter than explicit weaker configuration', () => {
    const args = claudeArgs(options({ nativeTools: 'none', settingSources: ['user', 'project', 'local'], strictMcpConfig: false }), '/owned/mcp.json');
    expect(flagValue(args, '--setting-sources')).toBe('');
    expect(args.filter(arg => arg === '--setting-sources')).toHaveLength(1);
    expect(args.filter(arg => arg === '--strict-mcp-config')).toHaveLength(1);
    expect(flagValue(args, '--tools')).toBe('');
    expect(args).toContain('--restricted');
  });
});

const parent = realpathSync(tmpdir());
const roots: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/claude-settings-provider.mjs', import.meta.url));
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = realpathSync(root);
    if (dirname(resolved) !== parent || !basename(resolved).startsWith('prism-setting-options-')) throw new Error('owned option fixture root changed');
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('Claude options on supervised startup and resume', () => {
  it.each(['startup', 'resume', 'relaunch'])('uses the constructor snapshot on %s', async mode => {
    const root = mkdtempSync(join(parent, 'prism-setting-options-')); roots.push(root);
    const marker = join(root, 'argv.json');
    const sources: Array<'user' | 'project'> = ['user'];
    const resumeSessionId = mode === 'startup' ? undefined : '11111111-1111-4111-8111-111111111111';
    if (mode === 'relaunch') {
      const firstMarker = join(root, 'first-argv.json');
      const first = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, firstMarker],
        settingSources: ['user'], strictMcpConfig: true,
        parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, TEMP: root, TMP: root },
      });
      try {
        first.start();
        await first.modelState();
        expect(flagValue((JSON.parse(readFileSync(firstMarker, 'utf8')) as { args: string[] }).args, '--setting-sources')).toBe('user');
      } finally {
        expect(await first.stop({ graceMs: 0 })).toMatchObject({ verified: true, empty: true, survivors: 0 });
      }
    }
    const driver = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, marker],
      settingSources: sources, strictMcpConfig: true, ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      parentEnv: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: process.env.PATH,
        HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root },
    });
    sources.push('project');
    try {
      driver.start();
      await driver.modelState();
      expect(existsSync(marker)).toBe(true);
      const { args } = JSON.parse(readFileSync(marker, 'utf8')) as { args: string[] };
      expect(flagValue(args, '--setting-sources')).toBe('user');
      expect(args).toContain('--strict-mcp-config');
      expect(flagValue(args, '--resume')).toBe(resumeSessionId);
    } finally {
      expect(await driver.stop({ graceMs: 0 })).toMatchObject({ verified: true, empty: true, survivors: 0 });
    }
  }, 20_000);
});
