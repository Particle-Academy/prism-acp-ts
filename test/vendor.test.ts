/**
 * Vendored test code is pinned by hash, so a change to it is a reviewed change rather than an edit nobody notices.
 * See acp-schema.ts for where each file came from.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PINNED: Readonly<Record<string, string>> = {
  'vendor/fancy-schema/index.js': 'ec596b9eff5f817ee42fb3b951c64feed98921886dadc18ce1849c40b94184ff',
  'vendor/fancy-schema/index.d.ts': '9e979f297f462d74217b3c7856469737ac2616b38c4004f60beecb69796c6b60',
  'vendor/fancy-schema/LICENSE': '9c194b64f52c76e677eb84a3e30f369c82727ea58abe50670d5de3f9ccd23270',
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
