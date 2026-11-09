import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPayload } from './release-payload.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function packedFiles(compressed) {
  assert(compressed.length <= 32 * 1024 * 1024);
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }), files = new Map();
  let cursor = 0, ended = false;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) { assert(tar.subarray(cursor).every(byte => byte === 0)); ended = true; break; }
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const octal = (start, length) => { const value = text(start, length).trim(); assert.match(value, /^[0-7]+$/); return Number.parseInt(value, 8); };
    const checksum = octal(148, 8); let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]; assert.equal(sum, checksum, 'Tar header checksum mismatch');
    const prefix = text(345, 155), name = (prefix ? prefix + '/' : '') + text(0, 100), size = octal(124, 12), kind = header[156];
    assert(name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..') && !files.has(name), 'Unique package-relative tar entry required');
    assert([0, 48, 53].includes(kind), 'Only regular files and directories may be packed');
    assert(cursor + 512 + size <= tar.length); if (kind === 53) assert.equal(size, 0); else files.set(name, tar.subarray(cursor + 512, cursor + 512 + size));
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  assert(ended, 'Complete tar terminator required');
  return files;
}
export function verifyPackedPayload(compressed, receipt, reviewedManifest) {
  const files = packedFiles(compressed), expected = ['package/native/supervisor-manifest.json', ...receipt.rows.map(row => 'package/native/' + row.file)].sort();
  assert.deepEqual([...files.keys()].filter(file => file.startsWith('package/native/')).sort(), expected);
  assert(files.get('package/native/supervisor-manifest.json')?.equals(reviewedManifest));
  for (const row of receipt.rows) { const bytes = files.get('package/native/' + row.file); assert(bytes); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256, 'Packed executable differs from verified signing artifact'); }
  assert.equal(JSON.parse(files.get('package/package.json').toString('utf8')).version, receipt.version);
  assert([...files.keys()].some(file => file.startsWith('package/dist/') && file.endsWith('.js')));
  return { files: files.size, native: receipt.rows.length, required: receipt.required };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [outputRoot, packRoot] = process.argv.slice(2), repository = fileURLToPath(new URL('../../', import.meta.url));
  assert(outputRoot && path.isAbsolute(outputRoot) && packRoot && path.isAbsolute(packRoot));
  const version = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'))).version;
  const receipt = verifyPayload({ nativeRoot: path.join(repository, 'native'), outputRoot, env: process.env, version, expectedReceipt: process.env.SUPERVISOR_RELEASE_SHA256 });
  const entries = fs.readdirSync(packRoot); assert.deepEqual(entries, ['particle-academy-prism-acp-' + version + '.tgz']);
  const tarball = fs.readFileSync(path.join(packRoot, entries[0]));
  const result = verifyPackedPayload(tarball, receipt, fs.readFileSync(path.join(repository, 'native/supervisor-manifest.json')));
  console.log(JSON.stringify({ supervisorNpmTarball: 'PASS', tarballSha256: sha256(tarball), ...result }));
}
