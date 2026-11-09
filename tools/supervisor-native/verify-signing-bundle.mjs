import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Reviewed source pins this manifest; a producer's own hash cannot authorize code.
const MANIFEST_SHA256 = '23892ba5df54f8855ba70fb31a70571e5765c5e477b466e44866a43ab67b8624';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifySigningBundle(root) {
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'Supported Node runtime required');
  assert(path.isAbsolute(root)); assert(!fs.lstatSync(root).isSymbolicLink());
  const manifestFile = path.join(root, 'verifier-manifest.json'), stat = fs.lstatSync(manifestFile);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 64 * 1024);
  const bytes = fs.readFileSync(manifestFile); assert.equal(sha256(bytes), MANIFEST_SHA256, 'Reviewed verifier manifest required');
  const manifest = JSON.parse(bytes); assert.equal(manifest.schemaVersion, 1);
  const allowed = new Set(['verifier-manifest.json', 'tools/supervisor-native/verify-signing-bundle.mjs',
    'unsigned/release-supervisors.json', 'unsigned/supervisor-manifest.json',
    'unsigned/win32-x64/prism-acp-supervisor.exe', 'unsigned/win32-arm64/prism-acp-supervisor.exe']);
  for (const record of manifest.files) {
    assert(!record.file.includes('..') && !record.file.includes('\\') && !path.isAbsolute(record.file)); assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert(!allowed.has(record.file)); allowed.add(record.file);
    const file = path.join(root, record.file), entry = fs.lstatSync(file); assert(entry.isFile() && !entry.isSymbolicLink() && entry.size <= 8 * 1024 * 1024);
    const data = fs.readFileSync(file); assert(['raw', 'lf'].includes(record.mode));
    assert.equal(sha256(record.mode === 'lf' ? Buffer.from(data.toString('utf8').replaceAll('\r\n', '\n')) : data), record.sha256, 'Reviewed verifier bytes required: ' + record.file);
  }
  let total = 0; const found = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(directory, entry.name); assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) walk(file, name + '/');
      else { assert(entry.isFile() && found.length < 20); const size = fs.statSync(file).size; total += size; assert(size <= 8 * 1024 * 1024 && total <= 32 * 1024 * 1024); found.push(name); }
    }
  }
  walk(root); assert.deepEqual(found.sort(), [...allowed].sort(), 'Closed signing bundle file set required');
  return { files: found.length, manifestSha256: MANIFEST_SHA256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifySigningBundle(process.argv[2]);
  console.log(JSON.stringify({ supervisorVerifierBundle: 'PASS', ...result }));
}
