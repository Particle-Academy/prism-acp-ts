import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeDriver, claudeArgs, type ClaudeDriverOptions } from '../src/claude/driver.js';

const options = (extra: Record<string, unknown> = {}) => ({ cwd: '.', ...extra }) as ClaudeDriverOptions;
const flagValue = (args: readonly string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const append = resolve('owned append $` % &.txt');
const directory = resolve('owned plugin $` % &');
const archive = resolve('owned plugin 🧪 % &.zip');
const badPaths = [null, 1, true, {}, [], '', 'relative/file', '--plugin-dir',
  append + '\0', append + '\n', append + '\r', append + '\t', append + '\u007f', append + '\u0085',
  append + '\u2028', append + '\u2029', append + '\ud800', append + '\udc00'];

describe('Claude append file and plugin paths', () => {
  it('preserves native default argv when both options are omitted', () => {
    expect(claudeArgs(options())).toEqual([
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--verbose', '--include-partial-messages',
    ]);
    expect(claudeArgs(options({ pluginDirs: [] }))).toEqual(claudeArgs(options()));
  });

  it('passes an absolute append file literally with explicit settings and MCP', () => {
    const args = claudeArgs(options({ appendSystemPromptFile: append }), '/owned/mcp.json', '/owned/settings.json');
    expect(flagValue(args, '--append-system-prompt-file')).toBe(append);
    expect(flagValue(args, '--mcp-config')).toBe('/owned/mcp.json');
    expect(flagValue(args, '--settings')).toBe('/owned/settings.json');
  });

  it('repeats plugin-dir for directory and zip paths in caller order', () => {
    const pluginDirs = Object.freeze([directory, archive]);
    const args = claudeArgs(options({ pluginDirs, appendSystemPromptFile: append }));
    expect(args.slice(args.indexOf('--plugin-dir'), args.indexOf('--plugin-dir') + 4)).toEqual([
      '--plugin-dir', directory, '--plugin-dir', archive,
    ]);
    expect(args.filter(arg => arg === '--plugin-dir')).toHaveLength(2);
    expect(pluginDirs).toEqual([directory, archive]);
  });

  it.each(badPaths.map((value, index) => ({ value, index })))('refuses malformed append paths before launch ($index)', ({ value }) => {
    for (const make of [() => claudeArgs(options({ appendSystemPromptFile: value })),
      () => new ClaudeDriver(options({ appendSystemPromptFile: value }))]) {
      expect(make).toThrow(/appendSystemPromptFile/);
      try { make(); } catch (error) { expect((error as Error).message).not.toContain(append); }
    }
  });

  it.each([null, 1, true, {}, directory, new Array(1), ...badPaths.map(value => [value])]
    .map((value, index) => ({ value, index })))('refuses malformed plugin lists before launch ($index)', ({ value }) => {
    expect(() => claudeArgs(options({ pluginDirs: value }))).toThrow(/pluginDirs/);
    expect(() => new ClaudeDriver(options({ pluginDirs: value }))).toThrow(/pluginDirs/);
  });

  it('refuses plugins with nativeTools none at both boundaries', () => {
    const restricted = options({ nativeTools: 'none', pluginDirs: [directory] });
    expect(() => claudeArgs(restricted, '/owned/mcp.json')).toThrow(/pluginDirs.*nativeTools/);
    expect(() => new ClaudeDriver(restricted)).toThrow(/pluginDirs.*nativeTools/);
  });

  it('allows an append file and empty plugins while preserving every nativeTools none restriction', () => {
    const args = claudeArgs(options({ nativeTools: 'none', pluginDirs: [], appendSystemPromptFile: append }), '/owned/mcp.json');
    expect(flagValue(args, '--append-system-prompt-file')).toBe(append);
    expect(flagValue(args, '--tools')).toBe('');
    expect(flagValue(args, '--setting-sources')).toBe('');
    expect(args.filter(arg => arg === '--strict-mcp-config')).toHaveLength(1);
    expect(args).toContain('--restricted');
    expect(args).not.toContain('--plugin-dir');
  });
});

const parent = realpathSync(tmpdir());
const roots: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/claude-settings-provider.mjs', import.meta.url));
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = realpathSync(root);
    if (dirname(resolved) !== parent || !basename(resolved).startsWith('prism-file-options-')) throw new Error('owned file fixture root changed');
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('Claude file options on supervised launches', () => {
  it.each(['startup', 'resume', 'relaunch'])('preserves literal paths and the constructor snapshot on %s', async mode => {
    const root = mkdtempSync(join(parent, 'prism-file-options-')); roots.push(root);
    const marker = join(root, 'argv.json');
    const pluginDirs = [directory];
    const resumeSessionId = mode === 'startup' ? undefined : '11111111-1111-4111-8111-111111111111';
    if (mode === 'relaunch') {
      const first = new ClaudeDriver({ cwd: root, binary: process.execPath, binaryArgs: [fixture, join(root, 'first-argv.json')],
        parentEnv: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, HOME: root, USERPROFILE: root, TEMP: root, TMP: root } });
      try { first.start(); await first.modelState(); } finally { expect(await first.stop({ graceMs: 0 })).toMatchObject({ verified: true, empty: true, survivors: 0 }); }
    }
    const driver = new ClaudeDriver(options({ cwd: root, binary: process.execPath, binaryArgs: [fixture, marker],
      appendSystemPromptFile: append, pluginDirs,
      parentEnv: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, PATH: process.env.PATH,
        HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root },
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    }));
    pluginDirs.push(archive);
    try {
      driver.start(); await driver.modelState();
      expect(existsSync(marker)).toBe(true);
      const args = (JSON.parse(readFileSync(marker, 'utf8')) as { args: string[] }).args;
      expect(flagValue(args, '--append-system-prompt-file')).toBe(append);
      expect(flagValue(args, '--plugin-dir')).toBe(directory);
      expect(args).not.toContain(archive);
      expect(args.filter(arg => arg === '--plugin-dir')).toHaveLength(1);
      if (resumeSessionId !== undefined) expect(flagValue(args, '--resume')).toBe(resumeSessionId);
    } finally { expect(await driver.stop({ graceMs: 0 })).toMatchObject({ verified: true, empty: true, survivors: 0 }); }
  });
});
