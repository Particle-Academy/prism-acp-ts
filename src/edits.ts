import { posix, win32 } from 'node:path';
import { MAX_LINE_BYTES } from './ndjson.js';

export type FileEditKind = 'add' | 'delete' | 'update';

/** Text is either the native complete add/delete body or Claude's exact replacement fragments. */
export interface FileEdit {
  readonly path: string;
  /** Workspace-relative rename destination; path remains the source. Absent for Claude fragments. */
  readonly movePath?: string;
  readonly kind: FileEditKind;
  readonly newText?: string;
  readonly oldText?: string;
  readonly diff: string;
  readonly textScope: 'file' | 'fragment';
}

export class FileEditRefused extends Error {
  override readonly name = 'FileEditRefused';
  readonly code = 'file_edit_unavailable';
  constructor() { super('The native file change cannot be represented as a workspace diff.'); }
}

const MAX_TEXT = MAX_LINE_BYTES;
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT || value.includes('\0')) throw new FileEditRefused();
  // UTF-8 encoding must not silently replace a path or text fragment's lone surrogate.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new FileEditRefused();
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new FileEditRefused();
  }
  return value;
}

/** Lexical workspace binding only; this formatter never reads or writes the edited file. */
function workspacePath(value: unknown, cwd?: string): string {
  const raw = text(value);
  if (raw.length === 0) throw new FileEditRefused();
  const windows = (cwd !== undefined && win32.isAbsolute(cwd) && !cwd.startsWith('/'))
    || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
  const paths = windows ? win32 : posix;
  let relative: string;
  if (cwd !== undefined) relative = paths.relative(paths.resolve(cwd), paths.resolve(cwd, raw));
  else {
    if (paths.isAbsolute(raw)) throw new FileEditRefused();
    relative = paths.normalize(raw);
  }
  if (relative === '' || relative === '.' || relative === '..' || relative.startsWith('..' + paths.sep)
    || paths.isAbsolute(relative)) throw new FileEditRefused();
  return windows ? relative.replaceAll('\\', '/') : relative;
}

/** Git's C-quoted path syntax, including UTF-8 octal escapes rather than JSON's unsupported \u escapes. */
function quote(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.every(c => c > 32 && c < 127 && c !== 34 && c !== 92)) return value;
  return '"' + [...bytes].map(c => {
    if (c === 34) return '\\"';
    if (c === 92) return '\\\\';
    if (c < 32 || c >= 127) return '\\' + c.toString(8).padStart(3, '0');
    return String.fromCharCode(c);
  }).join('') + '"';
}

function headers(oldPath: string | null, newPath: string | null): string {
  return '--- ' + (oldPath === null ? '/dev/null' : quote('a/' + oldPath))
    + '\n+++ ' + (newPath === null ? '/dev/null' : quote('b/' + newPath)) + '\n';
}

function bodyLines(body: string): { lines: string[]; newline: boolean } {
  if (body === '') return { lines: [], newline: true };
  const newline = body.endsWith('\n');
  return { lines: (newline ? body.slice(0, -1) : body).split('\n'), newline };
}

function changedLines(body: string, prefix: '+' | '-', eof: boolean): string {
  const { lines, newline } = bodyLines(body);
  return lines.map(line => prefix + line + '\n').join('')
    + (eof && !newline ? '\\ No newline at end of file\n' : '');
}

function fullBodyDiff(path: string, kind: 'add' | 'delete', body: string): string {
  const count = bodyLines(body).lines.length;
  const header = headers(kind === 'add' ? null : path, kind === 'delete' ? null : path);
  // An empty file needs Git's create/delete mode marker, not an invalid zero-line hunk.
  if (count === 0) return 'diff --git ' + quote('a/' + path) + ' ' + quote('b/' + path) + '\n'
    + (kind === 'add' ? 'new' : 'deleted') + ' file mode 100644\n' + header;
  const range = '1,' + count;
  return header
    + '@@ -' + (kind === 'add' ? '0,0' : range) + ' +' + (kind === 'delete' ? '0,0' : range) + ' @@\n'
    + changedLines(body, kind === 'add' ? '+' : '-', true);
}

/** Keep native hunk coordinates and context; never expand context by reading the workspace. */
function nativeHunks(value: unknown): string {
  const diff = text(value);
  const first = diff.search(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m);
  if (first < 0) throw new FileEditRefused();
  const hunk = diff.slice(first);
  let expectedOld = 0, expectedNew = 0, seenOld = 0, seenNew = 0, active = false, priorLine = false;
  const finish = (): void => {
    if (!active || expectedOld !== seenOld || expectedNew !== seenNew) throw new FileEditRefused();
  };
  const lines = hunk.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '' && i === lines.length - 1) break;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\r\n]*$/.exec(line);
    if (header !== null) {
      if (active) finish();
      expectedOld = Number(header[2] ?? '1'); expectedNew = Number(header[4] ?? '1');
      if (![expectedOld, expectedNew, Number(header[1]), Number(header[3])].every(Number.isSafeInteger)
        || expectedOld > MAX_TEXT || expectedNew > MAX_TEXT) throw new FileEditRefused();
      active = true; seenOld = 0; seenNew = 0; priorLine = false;
    } else if (line === '\\ No newline at end of file') {
      if (!active || !priorLine) throw new FileEditRefused();
      priorLine = false;
    } else {
      if (!active || ![' ', '-', '+'].includes(line[0] ?? '')) throw new FileEditRefused();
      if (line[0] !== '+') seenOld++;
      if (line[0] !== '-') seenNew++;
      if (seenOld > expectedOld || seenNew > expectedNew) throw new FileEditRefused();
      priorLine = true;
    }
  }
  finish();
  return hunk.endsWith('\n') ? hunk : hunk + '\n';
}

export function codexFileEdits(value: unknown, cwd: string): readonly FileEdit[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new FileEditRefused();
  return value.map((entry): FileEdit => {
    const change = object(entry), kind = object(change?.kind)?.type;
    const path = workspacePath(change?.path, cwd), body = text(change?.diff);
    if (kind === 'add') return { path, kind, newText: body, textScope: 'file', diff: fullBodyDiff(path, kind, body) };
    if (kind === 'delete') return { path, kind, oldText: body, textScope: 'file', diff: fullBodyDiff(path, kind, body) };
    if (kind !== 'update') throw new FileEditRefused();
    const moved = object(change?.kind)?.move_path;
    if (moved !== undefined && moved !== null) {
      const destination = workspacePath(moved, cwd);
      if (destination === path) throw new FileEditRefused();
      // CLI0.167 appends this exact display footer to moved updates. It is not a patch hunk.
      // Bind it to the native move_path; never strip arbitrary trailing content or another destination.
      const footer = '\n\nMoved to: ' + text(moved);
      const movedBody = body.endsWith(footer) ? body.slice(0, -footer.length) : body;
      return { path, movePath: destination, kind, textScope: 'file', diff:
        'diff --git ' + quote('a/' + path) + ' ' + quote('b/' + destination) + '\n'
        + 'rename from ' + quote(path) + '\nrename to ' + quote(destination) + '\n'
        + headers(path, destination) + (movedBody === '' ? '' : nativeHunks(movedBody)) };
    }
    return { path, kind, textScope: 'file', diff: headers(path, path) + nativeHunks(body) };
  });
}

/** Fragment-relative coordinates describe the supplied fragments, not a reconstructed whole file. */
export function claudeFileEdits(name: string | undefined, value: unknown, cwd?: string): readonly FileEdit[] | undefined {
  const lower = name?.toLowerCase();
  if (lower !== 'edit' && lower !== 'multiedit') return undefined;
  const input = object(value);
  if (input === undefined) throw new FileEditRefused();
  const path = workspacePath(input.file_path, cwd);
  const replacements = lower === 'multiedit' ? input.edits : [input];
  if (!Array.isArray(replacements) || replacements.length > 10_000) throw new FileEditRefused();
  return replacements.map((entry): FileEdit => {
    const edit = object(entry), oldText = text(edit?.old_string), newText = text(edit?.new_string);
    const oldCount = bodyLines(oldText).lines.length, newCount = bodyLines(newText).lines.length;
    return { path, kind: 'update', oldText, newText, textScope: 'fragment', diff: oldText === newText ? ''
      : headers(path, path) + '@@ -' + (oldCount === 0 ? '0,0' : '1,' + oldCount)
        + ' +' + (newCount === 0 ? '0,0' : '1,' + newCount) + ' @@\n'
        + changedLines(oldText, '-', false) + changedLines(newText, '+', false) };
  });
}
