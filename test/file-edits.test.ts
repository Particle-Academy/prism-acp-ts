import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeFileEdits, codexFileEdits, FileEditRefused } from '../src/edits.js';

const original = Array.from({ length: 20 }, (_, i) => 'CONTEXT_' + String(i + 1).padStart(2, '0')).join('\n') + '\n';
// Measured CLI0.167: one context line each side, not an invented three-line expansion.
const middleHunk = '@@ -9,3 +9,3 @@\n CONTEXT_09\n-CONTEXT_10\n+CHANGED_CONTEXT_10\n CONTEXT_11\n';

function scratch(run: (directory: string, git: (...args: string[]) => number) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'prism-acp-edits-'));
  const git = (...args: string[]): number => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    if (result.error || result.status === null) throw new Error('Git control did not run.');
    return result.status;
  };
  try {
    expect(git('init', '-q')).toBe(0);
    run(directory, git);
  } finally {
    expect(dirname(realpathSync(directory))).toBe(realpathSync(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe('native file edits produce independently applicable patches', () => {
  const cases = [
    { kind: 'add', path: 'owned.txt', body: 'ADD_CONTROL\n' },
    { kind: 'delete', path: 'owned.txt', body: 'DELETE_CONTROL\n' },
    { kind: 'update', path: 'owned.txt', body: middleHunk },
    { kind: 'add', path: 'owned.txt', body: 'NO_NEWLINE' },
    { kind: 'delete', path: 'owned.txt', body: 'NO_NEWLINE' },
    { kind: 'add', path: 'empty.txt', body: '' },
    { kind: 'delete', path: 'empty.txt', body: '' },
    { kind: 'add', path: 'nested/file with spaces.txt', body: 'SPACE_CONTROL\n' },
    { kind: 'add', path: '日本語.txt', body: 'UTF8_CONTROL\n' },
  ] as const;

  it.each(cases)('$kind $path (body=$body) applies and reverses with native Git', control => scratch((directory, git) => {
    const file = join(directory, control.path);
    mkdirSync(dirname(file), { recursive: true });
    const old = control.kind === 'update' ? original : control.body;
    if (control.kind !== 'add') writeFileSync(file, old);
    const [edit] = codexFileEdits([{ path: file, kind: { type: control.kind, move_path: null }, diff: control.body }], directory);
    expect(edit).toBeDefined();
    expect(edit!.path).toBe(control.path);
    expect(edit!.kind).toBe(control.kind);
    expect(edit!.diff).toContain('--- ');
    expect(edit!.diff).toContain('\n+++ ');
    if (control.kind === 'update') {
      expect(edit).not.toHaveProperty('oldText');
      expect(edit).not.toHaveProperty('newText');
      expect(edit!.diff).toContain(middleHunk);
    } else expect(edit![control.kind === 'add' ? 'newText' : 'oldText']).toBe(control.body);
    const patch = join(directory, 'control.patch');
    writeFileSync(patch, edit!.diff);
    expect(git('apply', '--check', patch)).toBe(0);
    expect(git('apply', patch)).toBe(0);
    if (control.kind === 'delete') expect(existsSync(file)).toBe(false);
    else expect(readFileSync(file, 'utf8')).toBe(control.kind === 'update'
      ? original.replace('CONTEXT_10\n', 'CHANGED_CONTEXT_10\n') : control.body);
    expect(git('apply', '--check', '-R', patch)).toBe(0);
    expect(git('apply', '-R', patch)).toBe(0);
    if (control.kind === 'add') expect(existsSync(file)).toBe(false);
    else expect(readFileSync(file, 'utf8')).toBe(old);
  }));

  it.each([[false, false], [true, false], [false, true], [true, true]])('keeps a native move reversible (footer=%s, pure=%s)', (footer, pure) => scratch((directory, git) => {
    writeFileSync(join(directory, 'old.txt'), 'OLD\n');
    const [edit] = codexFileEdits([{ path: join(directory, 'old.txt'),
      kind: { type: 'update', move_path: join(directory, 'new.txt') }, diff: (pure ? '' : '@@ -1 +1 @@\n-OLD\n+NEW\n')
        + (footer ? '\n\nMoved to: ' + join(directory, 'new.txt') : '') }], directory);
    expect(edit!.path).toBe('old.txt'); expect(edit!.movePath).toBe('new.txt'); expect(edit!.kind).toBe('update');
    const patch = join(directory, 'move.patch'); writeFileSync(patch, edit!.diff);
    expect(git('apply', '--check', patch)).toBe(0); expect(git('apply', patch)).toBe(0);
    expect(existsSync(join(directory, 'old.txt'))).toBe(false);
    expect(readFileSync(join(directory, 'new.txt'), 'utf8')).toBe(pure ? 'OLD\n' : 'NEW\n');
    expect(git('apply', '--check', '-R', patch)).toBe(0); expect(git('apply', '-R', patch)).toBe(0);
    expect(readFileSync(join(directory, 'old.txt'), 'utf8')).toBe('OLD\n');
  }));

  it('does not strip a rename footer naming a different target', () => {
    expect(() => codexFileEdits([{ path: '/owned/old.txt', kind: { type: 'update', move_path: '/owned/new.txt' },
      diff: '@@ -1 +1 @@\n-OLD\n+NEW\n\n\nMoved to: /owned/OTHER.txt' }], '/owned')).toThrow(FileEditRefused);
  });

  it('does not invent enough context to make a conflicting update apply', () => scratch((directory, git) => {
    const file = join(directory, 'owned.txt');
    const changed = original.replace('CONTEXT_09', 'CONFLICT'); writeFileSync(file, changed);
    const [edit] = codexFileEdits([{ path: file, kind: { type: 'update' }, diff: middleHunk }], directory);
    const patch = join(directory, 'conflict.patch'); writeFileSync(patch, edit!.diff);
    expect(git('apply', '--check', patch)).not.toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(changed);
  }));

  it('preserves a valid edit above one megabyte and applies/reverses it with native Git', () => scratch((directory, git) => {
    const body = 'A'.repeat(1_100_000) + '\n';
    const [edit] = codexFileEdits([{ path: join(directory, 'large.txt'), kind: { type: 'add' }, diff: body }], directory);
    expect(edit!.newText === body).toBe(true); expect(edit!.kind).toBe('add');
    const patch = join(directory, 'large.patch'); writeFileSync(patch, edit!.diff);
    expect(git('apply', '--check', patch)).toBe(0); expect(git('apply', patch)).toBe(0);
    expect(readFileSync(join(directory, 'large.txt'), 'utf8') === body).toBe(true);
    expect(git('apply', '-R', '--check', patch)).toBe(0); expect(git('apply', '-R', patch)).toBe(0);
    expect(existsSync(join(directory, 'large.txt'))).toBe(false);
  }));

  it('marks Claude old/new strings as fragments and preserves their exact text', () => scratch((directory, git) => {
    const [edit] = claudeFileEdits('Edit', { file_path: join(directory, 'owned.txt'), old_string: 'old', new_string: 'new' }, directory)!;
    expect(edit).toMatchObject({ path: 'owned.txt', kind: 'update', oldText: 'old', newText: 'new', textScope: 'fragment' });
    writeFileSync(join(directory, 'owned.txt'), 'prefix old suffix\n');
    const patch = join(directory, 'fragment.patch'); writeFileSync(patch, edit!.diff);
    // A fragment has no native whole-line context. Revert/apply must be checked, not promised.
    expect(git('apply', '--check', patch)).not.toBe(0);
    expect(readFileSync(join(directory, 'owned.txt'), 'utf8')).toBe('prefix old suffix\n');
  }));

  it.each([
    { path: '../escape', kind: { type: 'add' }, diff: 'x' },
    { path: 'owned.txt', kind: { type: 'unknown' }, diff: 'x' },
    { path: 'owned.txt', kind: { type: 'update' }, diff: 'not a hunk' },
    { path: 'owned.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-x\n+y\ndiff --git a/escape b/escape\n' },
    { path: 'owned.txt', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n-x\n+y\n' },
    { path: 'bad\0path', kind: { type: 'add' }, diff: 'x' },
  ])('refuses unrepresentable or injected changes without an extra patch target', change => {
    expect(() => codexFileEdits([change], '/owned')).toThrow(FileEditRefused);
  });
});
