import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { SUPERVISOR_CS } from '../src/process-tree-supervisor-cs.js';
import { signingConfiguration, signingRequired } from '../tools/supervisor-native/signing-policy.mjs';
import { finalizePayload, installPayload, preparePayload, verifyImage, verifyPayload } from '../tools/supervisor-native/release-payload.mjs';
import { packedFiles, verifyPackedPayload } from '../tools/supervisor-native/verify-pack.mjs';

const nativeRoot = path.resolve('native'), version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string;
const env = { GITHUB_SHA: '1'.repeat(40), GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v' + version,
  GITHUB_REPOSITORY: 'Particle-Academy/prism-acp-ts', REQUIRE_SUPERVISOR_SIGNING: 'false' };
const configured = { ...env, REQUIRE_SUPERVISOR_SIGNING: 'true', AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222', AZURE_SUBSCRIPTION_ID: '33333333-3333-3333-3333-333333333333',
  ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/', ARTIFACT_SIGNING_ACCOUNT: 'owned-test-account', ARTIFACT_SIGNING_PROFILE: 'owned-test-profile' };
const roots: string[] = [];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function staging(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-release-test-')); roots.push(root); return path.join(root, 'payload'); }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function unsigned() {
  const outputRoot = staging(); preparePayload({ nativeRoot, outputRoot, env, version });
  const result = finalizePayload({ nativeRoot, outputRoot, env, version });
  return { nativeRoot, outputRoot, env, version, expectedReceipt: result.sha256 };
}
const manifest = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'supervisor-manifest.json'), 'utf8'));
function certificateCopy(bytes: Buffer): Buffer {
  // Format-only fixture: publisher trust is checked by Windows, never inferred here.
  const copy = Buffer.concat([bytes, Buffer.alloc(24, 0)]), pe = copy.readUInt32LE(0x3c), security = pe + 24 + 112 + 32;
  copy.writeUInt32LE(bytes.length, security); copy.writeUInt32LE(24, security + 4);
  copy.writeUInt32LE(24, bytes.length); copy.writeUInt16LE(0x200, bytes.length + 4); copy.writeUInt16LE(2, bytes.length + 6);
  copy.fill(0x42, bytes.length + 8); return copy;
}
function tarball(entries: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of entries) {
    const header = Buffer.alloc(512); header.write(name); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header[156] = 48;
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
describe('release-only supervisor signing boundary', () => {
  it('leaves the reviewed C# source and unsigned assets unchanged', () => {
    expect(sha(Buffer.from(SUPERVISOR_CS))).toBe(manifest.sourceSha256);
    for (const arch of ['x64', 'arm64']) expect(sha(fs.readFileSync(path.join(nativeRoot, manifest.binaries[arch].file)))).toBe(manifest.binaries[arch].sha256);
  });
  it.each(['', 'false'])('keeps the explicit disabled policy unsigned: %s', value => {
    expect(signingRequired(value)).toBe(false); expect(signingConfiguration({ REQUIRE_SUPERVISOR_SIGNING: value })).toEqual({ required: false });
  });
  it.each(['TRUE', 'False', '1', ' true', 'false\n', 'yes'])('refuses an ambiguous signing policy: %s', value => {
    expect(() => signingRequired(value)).toThrow();
  });
  it('accepts only the complete configured OIDC variable set when required', () => {
    expect(signingConfiguration(configured)).toEqual({ required: true });
  });
  it.each(['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID', 'ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE'])('refuses missing %s before creating staging files', key => {
    const outputRoot = staging(); expect(() => preparePayload({ nativeRoot, outputRoot, env: { ...configured, [key]: '' }, version })).toThrow(key);
    expect(fs.existsSync(outputRoot)).toBe(false);
  });
  it.each(['http://eus.codesigning.azure.net', 'https://eus.codesigning.azure.net.attacker.invalid', 'https://user@eus.codesigning.azure.net', 'https://eus.codesigning.azure.net/path'])('refuses an unapproved signing endpoint: %s', endpoint => {
    expect(() => signingConfiguration({ ...configured, ARTIFACT_SIGNING_ENDPOINT: endpoint })).toThrow('ARTIFACT_SIGNING_ENDPOINT');
  });
  it('refuses staging reuse and non-tag source before writing', () => {
    const outputRoot = staging(); expect(() => preparePayload({ nativeRoot, outputRoot, env: { ...env, GITHUB_REF_TYPE: 'branch' }, version })).toThrow();
    expect(fs.existsSync(outputRoot)).toBe(false); preparePayload({ nativeRoot, outputRoot, env, version });
    expect(() => preparePayload({ nativeRoot, outputRoot, env, version })).toThrow('reuse');
  });
  it('records both unsigned payloads and installs only their exact recorded bytes', () => {
    const options = unsigned(), receipt = verifyPayload(options), consumer = path.join(path.dirname(options.outputRoot), 'consumer');
    fs.cpSync(nativeRoot, consumer, { recursive: true });
    expect(receipt.required).toBe(false); expect(receipt.rows.map((row: any) => row.architecture)).toEqual(['x64', 'arm64']);
    installPayload({ ...options, nativeRoot: consumer });
    for (const row of receipt.rows) expect(sha(fs.readFileSync(path.join(consumer, row.file)))).toBe(row.sha256);
  });
  it('refuses a required release when signing left either image unsigned', () => {
    const outputRoot = staging(); preparePayload({ nativeRoot, outputRoot, env: configured, version });
    expect(() => finalizePayload({ nativeRoot, outputRoot, env: configured, version })).toThrow('certificate');
    expect(fs.existsSync(path.join(outputRoot, 'release-supervisors.json'))).toBe(false);
  });
  it.each(['x64', 'arm64'])('detects modified signed-format %s image code while preserving the original digest under a certificate', arch => {
    const pin = manifest.binaries[arch], bytes = fs.readFileSync(path.join(nativeRoot, pin.file)), signed = certificateCopy(bytes);
    expect(verifyImage(signed, arch, pin, true).sha256).toBe(pin.authenticodeSha256);
    signed[bytes.length - 1] ^= 1; expect(() => verifyImage(signed, arch, pin, true)).toThrow('digest');
  });
  it('refuses a tampered producer receipt even if the files are unchanged', () => {
    const options = unsigned(), file = path.join(options.outputRoot, 'release-supervisors.json'); fs.appendFileSync(file, ' ');
    expect(() => verifyPayload(options)).toThrow('receipt SHA256');
  });
  it('detects same-size certificate replacement across jobs even when the reviewed image digest is unchanged', () => {
    // A producer-receipt FORMAT fixture, not evidence of Windows publisher trust.
    // Actual trusted signatures are checked in the Windows producer before its
    // receipt digest is exposed to the npm consumer.
    const options = unsigned(), file = path.join(options.outputRoot, 'release-supervisors.json'), receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt.required = true; receipt.signatures = [];
    for (const row of receipt.rows) {
      const imageFile = path.join(options.outputRoot, row.file), signed = certificateCopy(fs.readFileSync(imageFile));
      fs.writeFileSync(imageFile, signed); row.bytes = signed.length; row.sha256 = sha(signed);
      receipt.signatures.push({ architecture: row.architecture, sha256: row.sha256, status: 'Valid', signatureType: 'Authenticode', hasTimestamp: true, publisherName: 'Renaissance Analytics' });
    }
    fs.writeFileSync(file, JSON.stringify(receipt)); const signedOptions = { ...options, env: { ...env, REQUIRE_SUPERVISOR_SIGNING: 'true' }, expectedReceipt: sha(fs.readFileSync(file)) };
    expect(verifyPayload(signedOptions).required).toBe(true);
    const wrongPublisher = structuredClone(receipt); wrongPublisher.signatures[0].publisherName = 'Other Renaissance Analytics Publisher';
    fs.writeFileSync(file, JSON.stringify(wrongPublisher));
    expect(() => verifyPayload({ ...signedOptions, expectedReceipt: sha(fs.readFileSync(file)) })).toThrow('Approved publisher');
    fs.writeFileSync(file, JSON.stringify(receipt));
    const imageFile = path.join(options.outputRoot, receipt.rows[0].file), replacement = fs.readFileSync(imageFile); replacement[replacement.length - 1] ^= 1; fs.writeFileSync(imageFile, replacement);
    expect(() => verifyPayload(signedOptions)).toThrow();
  });
  it.each(['commit', 'tag', 'required'])('refuses a cross-context producer receipt: %s', key => {
    const options = unsigned(), file = path.join(options.outputRoot, 'release-supervisors.json'), receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt[key] = key === 'required' ? true : 'wrong-context'; fs.writeFileSync(file, JSON.stringify(receipt));
    expect(() => verifyPayload({ ...options, expectedReceipt: sha(fs.readFileSync(file)) })).toThrow();
  });
  it('checks both images before modifying either consumer image', () => {
    const options = unsigned(), receipt = verifyPayload(options), consumer = path.join(path.dirname(options.outputRoot), 'consumer'); fs.cpSync(nativeRoot, consumer, { recursive: true });
    const bad = path.join(options.outputRoot, receipt.rows[1].file); fs.appendFileSync(bad, 'changed');
    expect(() => installPayload({ ...options, nativeRoot: consumer })).toThrow();
    for (const row of receipt.rows) expect(sha(fs.readFileSync(path.join(consumer, row.file)))).toBe(manifest.binaries[row.architecture].sha256);
  });
  it('rejects extra signing payload files including key material', () => {
    const options = unsigned(); fs.writeFileSync(path.join(options.outputRoot, 'key.pfx'), 'owned-sentinel');
    expect(() => verifyPayload(options)).toThrow();
  });
  it('binds actual tar entry bytes to both producer image hashes and the reviewed manifest', () => {
    const options = unsigned(), receipt = verifyPayload(options), reviewed = fs.readFileSync(path.join(nativeRoot, 'supervisor-manifest.json'));
    const entries: [string, Buffer][] = [
      ['package/package.json', Buffer.from(JSON.stringify({ version }))], ['package/dist/index.js', Buffer.from('export {};')],
      ['package/native/supervisor-manifest.json', reviewed],
      ...receipt.rows.map((row: any) => ['package/native/' + row.file, fs.readFileSync(path.join(options.outputRoot, row.file))] as [string, Buffer]),
    ];
    expect(verifyPackedPayload(tarball(entries), receipt, reviewed)).toEqual({ files: 5, native: 2, required: false });
    const badImage = entries.map(([name, bytes]) => [name, Buffer.from(bytes)] as [string, Buffer]); badImage[3][1][500] ^= 1;
    expect(() => verifyPackedPayload(tarball(badImage), receipt, reviewed)).toThrow('Packed executable');
    expect(() => verifyPackedPayload(tarball([...entries, ['package/native/unrecorded.exe', Buffer.from('extra')]]), receipt, reviewed)).toThrow();
    const wrongManifest = entries.map(([name, bytes]) => [name, name.endsWith('supervisor-manifest.json') ? Buffer.from('{}') : bytes] as [string, Buffer]);
    expect(() => verifyPackedPayload(tarball(wrongManifest), receipt, reviewed)).toThrow();
  });
  it.each(['package/../escape', '/absolute', 'package/\\escape'])('refuses a tar path outside the package: %s', name => {
    expect(() => packedFiles(tarball([[name, Buffer.from('owned')]]))).toThrow();
  });
  it('refuses duplicate package file records and truncated tar bodies', () => {
    expect(() => packedFiles(tarball([['package/a', Buffer.from('a')], ['package/a', Buffer.from('b')]]))).toThrow();
    expect(() => packedFiles(tarball([['package/a', Buffer.from('a')]]).subarray(0, 15))).toThrow();
  });
});
