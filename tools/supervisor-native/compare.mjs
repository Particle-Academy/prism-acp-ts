import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authenticodeImage } from '../../dist/authenticode.js';
const [first, second, reviewed] = process.argv.slice(2);
assert(first && second && path.isAbsolute(first) && path.isAbsolute(second) && first !== second, 'Two distinct absolute build roots required');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = fs.readFileSync(path.join(first, 'supervisor-manifest.json'));
assert(fs.readFileSync(path.join(second, 'supervisor-manifest.json')).equals(manifest), 'Rebuild inputs/pins differ');
const value = JSON.parse(manifest);
assert.equal(value.schemaVersion, 1);
assert.deepEqual(Object.keys(value.binaries), ['x64', 'arm64']);
if (reviewed) {
  assert(path.isAbsolute(reviewed), 'Reviewed package root must be absolute');
  assert(fs.readFileSync(path.join(reviewed, 'supervisor-manifest.json')).equals(manifest), 'Rebuild manifest differs from reviewed package');
}
for (const architecture of ['x64', 'arm64']) {
  const record = value.binaries[architecture], relative = 'win32-' + architecture + '/prism-acp-supervisor.exe';
  assert.equal(record.file, relative);
  const a = fs.readFileSync(path.join(first, relative)), b = fs.readFileSync(path.join(second, relative));
  assert(a.equals(b), 'Deterministic raw bytes differ for ' + architecture);
  if (reviewed) assert(a.equals(fs.readFileSync(path.join(reviewed, relative))), 'Rebuilt bytes differ from reviewed package for ' + architecture);
  assert.equal(a.length, record.bytes);
  assert.equal(sha256(a), record.sha256);
  const digest = authenticodeImage(a);
  assert.equal(digest.architecture, architecture); assert.equal(digest.certificateBytes, 0);
  assert.equal(digest.sha256, record.authenticodeSha256);
}
console.log(JSON.stringify({ supervisorReproduction: { status: 'PASS', sourceSha256: value.sourceSha256, manifestSha256: sha256(manifest), architectures: ['x64', 'arm64'], rawBytesEqual: true } }));
