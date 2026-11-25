/**
 * Vendored test files are pinned by hash, so a change to one is a reviewed change rather than an edit nobody notices.
 * See acp-schema.ts for where the ACP schema came from.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PINNED: Readonly<Record<string, string>> = {
  'fixtures/acp-v1-schema.json': 'd3ddaefbee593abf74beeda91bdf57b58ef99bf90219dc1cb4ae90be3ba18518',
};

describe('vendored test files', () => {
  it.each(Object.entries(PINNED))('%s has the reviewed bytes', (file, hash) => {
    // Line endings normalised, so a Windows checkout reads the same bytes as the reviewed LF copy.
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    const actual = createHash('sha256').update(text).digest('hex');
    expect(actual).toBe(hash);
  });
});
