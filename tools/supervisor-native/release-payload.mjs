import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authenticodeImage } from '../../dist/authenticode.js';
import { signingRequired, signingConfiguration } from './signing-policy.mjs';

const architectures = ['x64', 'arm64'];
const repository = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const relativeImage = arch => 'win32-' + arch + '/prism-acp-supervisor.exe';
const receiptFile = 'release-supervisors.json';
function readFile(file, limit = 8 * 1024 * 1024) {
  const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Regular bounded file required');
  return fs.readFileSync(file);
}
function context(env, version) {
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(env.GITHUB_REF_TYPE, 'tag'); assert.equal(env.GITHUB_REF_NAME, 'v' + version);
  assert.equal(env.GITHUB_REPOSITORY, 'Particle-Academy/prism-acp-ts');
  return { commit: env.GITHUB_SHA, tag: env.GITHUB_REF_NAME, version, repository: env.GITHUB_REPOSITORY };
}
function reviewed(root) {
  const bytes = readFile(path.join(root, 'supervisor-manifest.json'), 64 * 1024), manifest = JSON.parse(bytes);
  assert.equal(manifest.schemaVersion, 1); assert.deepEqual(Object.keys(manifest.binaries), architectures);
  for (const arch of architectures) assert.equal(manifest.binaries[arch].file, relativeImage(arch));
  return { bytes, manifest };
}
export function verifyImage(bytes, arch, pin, required) {
  assert.equal(pin.file, relativeImage(arch));
  const image = authenticodeImage(bytes);
  assert.equal(image.architecture, arch); assert.equal(image.bodyBytes, pin.bytes);
  assert.equal(image.sha256, pin.authenticodeSha256, 'Reviewed image digest required');
  if (required) assert(image.certificateBytes > 8, 'Signed certificate table required');
  else { assert.equal(image.certificateBytes, 0); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
  return image;
}
export function preparePayload({ nativeRoot, outputRoot, env, version }) {
  const { required } = signingConfiguration(env), identity = context(env, version);
  assert(path.isAbsolute(outputRoot)); assert(!fs.existsSync(outputRoot), 'Refuse to reuse a release staging directory');
  const { bytes, manifest } = reviewed(nativeRoot);
  const images = architectures.map(arch => {
    const data = readFile(path.join(nativeRoot, relativeImage(arch))); verifyImage(data, arch, manifest.binaries[arch], false); return { arch, data };
  });
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'supervisor-manifest.json'), bytes, { flag: 'wx' });
  for (const { arch, data } of images) { const target = path.join(outputRoot, relativeImage(arch)); fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, data, { flag: 'wx' }); }
  fs.writeFileSync(path.join(outputRoot, 'release-input.json'), JSON.stringify({ ...identity, required, manifestSha256: sha256(bytes) }) + '\n', { flag: 'wx' });
  return { required };
}
function publisherSignatures(directory) {
  assert.equal(process.platform, 'win32', 'Windows publisher verification required');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const env = {}; for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./publisher-signature.ps1', import.meta.url)), '-Directory', directory], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, 'Windows publisher signature verification refused');
  const rows = JSON.parse(result.stdout.trim()); assert.equal(rows.length, 2);
  for (const [index, arch] of architectures.entries()) {
    const row = rows[index]; assert.equal(row.architecture, arch); assert.equal(row.status, 'Valid'); assert.equal(row.signatureType, 'Authenticode'); assert.equal(row.hasTimestamp, true);
    assert.equal(row.sha256, sha256(readFile(path.join(directory, relativeImage(arch)))));
    assert.equal(row.publisherName, 'Renaissance Analytics', 'Approved publisher required');
    assert(row.publisher && row.certificateThumbprint && row.timestampPublisher);
  }
  return rows;
}
export function finalizePayload({ nativeRoot, outputRoot, env, version }) {
  const required = signingRequired(env.REQUIRE_SUPERVISOR_SIGNING), identity = context(env, version);
  const { bytes, manifest } = reviewed(nativeRoot);
  const inputPath = path.join(outputRoot, 'release-input.json'), input = JSON.parse(readFile(inputPath, 64 * 1024));
  assert.deepEqual(input, { ...identity, required, manifestSha256: sha256(bytes) });
  assert(readFile(path.join(outputRoot, 'supervisor-manifest.json')).equals(bytes));
  const rows = architectures.map(arch => {
    const file = relativeImage(arch), data = readFile(path.join(outputRoot, file)); verifyImage(data, arch, manifest.binaries[arch], required);
    return { architecture: arch, file, bytes: data.length, sha256: sha256(data), authenticodeSha256: manifest.binaries[arch].authenticodeSha256 };
  });
  const signatures = required ? publisherSignatures(outputRoot) : [];
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, ...identity, required, manifestSha256: sha256(bytes), rows, signatures }) + '\n');
  fs.writeFileSync(path.join(outputRoot, receiptFile), receipt, { flag: 'wx' });
  fs.unlinkSync(inputPath);
  return { sha256: sha256(receipt), required };
}
export function verifyPayload({ nativeRoot, outputRoot, env, version, expectedReceipt }) {
  assert.match(expectedReceipt ?? '', /^[a-f0-9]{64}$/, 'Producer receipt SHA256 required');
  const receiptBytes = readFile(path.join(outputRoot, receiptFile), 64 * 1024); assert.equal(sha256(receiptBytes), expectedReceipt, 'Producer receipt SHA256 mismatch');
  const receipt = JSON.parse(receiptBytes), required = signingRequired(env.REQUIRE_SUPERVISOR_SIGNING), identity = context(env, version);
  for (const [key, value] of Object.entries(identity)) assert.equal(receipt[key], value);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.required, required);
  const { bytes, manifest } = reviewed(nativeRoot); assert.equal(sha256(bytes), receipt.manifestSha256); assert(readFile(path.join(outputRoot, 'supervisor-manifest.json')).equals(bytes));
  assert.equal(receipt.rows.length, 2); assert.equal(receipt.signatures.length, required ? 2 : 0);
  for (const [index, arch] of architectures.entries()) {
    const row = receipt.rows[index], file = relativeImage(arch), data = readFile(path.join(outputRoot, file));
    assert.equal(row.architecture, arch); assert.equal(row.file, file); assert.equal(row.bytes, data.length); assert.equal(row.sha256, sha256(data));
    assert.equal(row.authenticodeSha256, manifest.binaries[arch].authenticodeSha256); verifyImage(data, arch, manifest.binaries[arch], required);
    if (required) { const sig = receipt.signatures[index]; assert.equal(sig.architecture, arch); assert.equal(sig.sha256, row.sha256); assert.equal(sig.status, 'Valid'); assert.equal(sig.signatureType, 'Authenticode'); assert.equal(sig.hasTimestamp, true); assert.equal(sig.publisherName, 'Renaissance Analytics', 'Approved publisher required'); }
  }
  // No unrecorded file, key, path, or executable can join the cross-job payload.
  assert.deepEqual(fs.readdirSync(outputRoot).sort(), [receiptFile, 'supervisor-manifest.json', 'win32-arm64', 'win32-x64'].sort());
  for (const arch of architectures) { const folder = path.join(outputRoot, 'win32-' + arch); assert(!fs.lstatSync(folder).isSymbolicLink()); assert.deepEqual(fs.readdirSync(folder), ['prism-acp-supervisor.exe']); }
  return receipt;
}
export function installPayload(options) {
  const receipt = verifyPayload(options);
  // Check the entire two-image input before replacing either npm asset.
  for (const arch of architectures) verifyImage(readFile(path.join(options.nativeRoot, relativeImage(arch))), arch, reviewed(options.nativeRoot).manifest.binaries[arch], false);
  for (const arch of architectures) fs.copyFileSync(path.join(options.outputRoot, relativeImage(arch)), path.join(options.nativeRoot, relativeImage(arch)));
  for (const row of receipt.rows) assert.equal(sha256(readFile(path.join(options.nativeRoot, row.file))), row.sha256);
  return receipt;
}
export function prepareSignedPayload({ nativeRoot, unsignedRoot, outputRoot, env, version, expectedReceipt }) {
  assert.equal(signingConfiguration(env).required, true, 'Required signing policy expected');
  verifyPayload({ nativeRoot, outputRoot: unsignedRoot, env: { ...env, REQUIRE_SUPERVISOR_SIGNING: 'false' }, version, expectedReceipt });
  return preparePayload({ nativeRoot: unsignedRoot, outputRoot, env, version });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, outputRoot, unsignedRoot] = process.argv.slice(2); assert(['prepare', 'prepare-signed', 'finalize', 'install'].includes(operation)); assert(outputRoot && path.isAbsolute(outputRoot));
  const options = { nativeRoot: path.join(repository, 'native'), outputRoot, env: process.env, version: JSON.parse(fs.readFileSync(path.join(repository, 'package.json'))).version, expectedReceipt: process.env.SUPERVISOR_RELEASE_SHA256 };
  const result = operation === 'prepare' ? preparePayload(options) : operation === 'prepare-signed' ? prepareSignedPayload({ ...options, unsignedRoot, expectedReceipt: process.env.SUPERVISOR_UNSIGNED_RELEASE_SHA256 }) : operation === 'finalize' ? finalizePayload(options) : installPayload(options);
  if (operation === 'finalize') { assert(process.env.GITHUB_OUTPUT); fs.appendFileSync(process.env.GITHUB_OUTPUT, 'sha256=' + result.sha256 + '\n'); }
  console.log(JSON.stringify({ supervisorReleasePayload: operation, required: result.required, sha256: operation === 'finalize' ? result.sha256 : undefined }));
}
