import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authenticodeImage } from '../../dist/authenticode.js';
const directory = process.argv[2];
assert(directory && path.isAbsolute(directory));
const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'signed-image-receipt.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../../native/supervisor-manifest.json', import.meta.url), 'utf8'));
assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.rows.length, 2);
assert.equal(receipt.noTrustStoreChanges, true); assert.equal(receipt.disposableKeyRemoved, true);
for (const [index, arch] of ['x64', 'arm64'].entries()) {
  const row = receipt.rows[index]; assert.equal(row.architecture, arch); assert.equal(row.file, arch + '-signed.exe');
  const bytes = fs.readFileSync(path.join(directory, row.file)), image = authenticodeImage(bytes);
  assert.equal(image.architecture, arch); assert(image.certificateBytes > 8);
  assert.equal(image.sha256, row.windowsSipSha256); assert.equal(image.sha256, manifest.binaries[arch].authenticodeSha256);
  assert.equal(image.bodyBytes, manifest.binaries[arch].bytes);
  assert.equal(row.rawBefore, manifest.binaries[arch].sha256);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.rawAfter); assert.notEqual(row.rawAfter, row.rawBefore);
  assert.equal(row.signature, 'Authenticode'); assert.equal(row.chain, 'UntrustedRoot');
  assert.equal(row.cmsSignatureVerified, true); assert.equal(row.cmsContentSha256, image.sha256);
}
assert(!fs.existsSync(path.join(directory, 'disposable-key.pfx')));
console.log(JSON.stringify({ signedSupervisorImageOracle: 'PASS', architectures: ['x64', 'arm64'], independentWindowsSip: true, genuineSignatures: true, trustedPublisherAcceptance: 'UNMEASURED' }));
