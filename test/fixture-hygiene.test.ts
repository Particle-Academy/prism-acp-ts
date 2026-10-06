/**
 * Captured fixtures must not carry anyone's filesystem.
 *
 * These files are real agent traffic, which is what makes them worth having and
 * also what makes them a disclosure risk: a capture arrives full of local paths,
 * installed plugin directories and temp files. The redaction is applied when a
 * fixture is generated, and this asserts it on every run -- because a redaction
 * nobody verified is one that has already failed somewhere.
 *
 * It happened twice while these three were made. A key-based redaction missed
 * five keys that hold paths (plugins, memory_paths, filePath, file_path, and a
 * map keyed by tool id), which is how a deny-list is always wrong. Then a
 * cleverer value-based regex matched `C:\U` and stopped at the next backslash,
 * leaving the rest of the path in place -- a redaction that LOOKED applied.
 *
 * Deliberately phrased as "no home-directory path", not "not this username".
 * Asserting a specific name would commit that name to the repository, which is
 * the problem rather than the check.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith('.ndjson'));

/** Home-directory shapes on either platform, escaped or not. */
const HOME_PATHS = [
  /[A-Za-z]:\{1,4}Users\{1,4}[^\\"]+/,
  /\/home\/[^/"\s]+/,
  /\/Users\/[^/"\s]+/,
  /\/root\//,
];

describe('fixture hygiene', () => {
  it('has fixtures to check, so a pass cannot mean an empty directory', () => {
    // The vacuity guard. Without it this file reports success when the
    // fixtures move and it is checking nothing at all.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(FIXTURES)('%s contains no home-directory path', (name) => {
    const text = readFileSync(`${DIR}${name}`, 'utf8');
    for (const pattern of HOME_PATHS) {
      const found = pattern.exec(text);
      expect(found?.[0] ?? null, `${name} leaks ${String(found?.[0])}`).toBeNull();
    }
  });

  it.each(FIXTURES)('%s is still valid NDJSON after redaction', (name) => {
    // Redaction edits strings inside JSON. A substitution that broke an escape
    // would corrupt the file, and every mapper test reading it would then fail
    // for a reason nobody would look for here.
    const lines = readFileSync(`${DIR}${name}`, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
