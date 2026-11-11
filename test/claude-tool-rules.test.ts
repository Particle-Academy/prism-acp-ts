import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeDriver, claudeArgs, type ClaudeDriverOptions } from '../src/claude/driver.js';
import { ClaudeToolRuleError } from '../src/index.js';

describe('Claude permission rule argv boundaries', () => {
  const rules = ['Bash(echo g258, comma space)', 'Read(path with spaces,commas/**)'];

  it.each(['allowedTools', 'disallowedTools'] as const)('passes each %s rule as its own value after one flag', field => {
    const flag = field === 'allowedTools' ? '--allowed-tools' : '--disallowed-tools';
    const args = claudeArgs({ cwd: '/w', [field]: rules, model: 'sonnet' });
    expect(args.filter(value => value === flag)).toHaveLength(1);
    expect(args.slice(args.indexOf(flag) + 1)).toEqual(rules);
  });

  it('keeps both lists separate and retains caller-owned arrays', () => {
    const allowed = Object.freeze([...rules]);
    const denied = Object.freeze(['Bash(git log --format="%h, %s")', 'Write']);
    const args = claudeArgs({ cwd: '/w', allowedTools: allowed, disallowedTools: denied });
    expect(args.slice(args.indexOf('--allowed-tools'))).toEqual([
      '--allowed-tools', ...allowed, '--disallowed-tools', ...denied,
    ]);
    expect(allowed).toEqual(rules);
    expect(denied).toEqual(['Bash(git log --format="%h, %s")', 'Write']);
  });

  it('preserves comma, space, quotes and Unicode through an actual child argv', () => {
    const allowed = [...rules, 'Bash(echo "quoted, value")', 'Read(資料, one/**)'];
    const denied = ['Bash(echo denied, two words)', 'Write'];
    const args = claudeArgs({ cwd: '/w', allowedTools: allowed, disallowedTools: denied });
    // No shell: this exercises Node's real Windows/POSIX process argument transport.
    const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
    });
    const observed = JSON.parse(output) as string[];
    expect(observed.slice(observed.indexOf('--allowed-tools'))).toEqual([
      '--allowed-tools', ...allowed, '--disallowed-tools', ...denied,
    ]);
  });

  it.each(['allowedTools', 'disallowedTools'] as const)('refuses malformed runtime %s before launch', field => {
    const invalid: unknown[] = [null, 'Bash', {}, [null], [3], [''], [' '], ['--permission-mode'], [' -p'], ['Read\u0000'], ['Bash(echo\nhello)'], ['Read(\ud800)'], new Array(1)];
    for (const value of invalid) {
      const options = { cwd: '/w', [field]: value } as ClaudeDriverOptions;
      expect(() => claudeArgs(options)).toThrow(ClaudeToolRuleError);
      expect(() => new ClaudeDriver(options)).toThrow(ClaudeToolRuleError);
      try { claudeArgs(options); } catch (error) {
        expect(error).toMatchObject({ code: 'invalid_claude_tool_rule', field });
        expect((error as Error).message).not.toContain('permission-mode');
      }
    }
  });

  it('snapshots both host arrays before the driver starts its actual child', async () => {
    const own = mkdtempSync(join(tmpdir(), 'prism-rule-argv-'));
    const script = join(own, 'argv.cjs'), file = join(own, 'argv.json');
    writeFileSync(script, 'require("node:fs").writeFileSync("argv.json", JSON.stringify(process.argv.slice(2)));');
    const allowed = [...rules], denied = ['Write'];
    let finish!: () => void;
    const exited = new Promise<void>(done => { finish = done; });
    const driver = new ClaudeDriver({ cwd: own, binary: process.execPath, binaryArgs: [script],
      parentEnv: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
      allowedTools: allowed, disallowedTools: denied }, { onExit: finish });
    allowed.splice(0, allowed.length, '--permission-mode');
    denied.length = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      driver.start();
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned argv child did not exit')), 10_000);
      })]);
      const args = JSON.parse(readFileSync(file, 'utf8')) as string[];
      expect(args.slice(args.indexOf('--allowed-tools'))).toEqual(['--allowed-tools', ...rules, '--disallowed-tools', 'Write']);
    } finally {
      clearTimeout(timer);
      await driver.stop({ graceMs: 0 });
      expect(resolve(own).startsWith(resolve(tmpdir()) + sep)).toBe(true);
      rmSync(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
