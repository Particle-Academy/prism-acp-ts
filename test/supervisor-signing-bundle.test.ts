import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { stageSigningBundle } from '../tools/supervisor-native/stage-signing-bundle.mjs';
import { verifySigningBundle } from '../tools/supervisor-native/verify-signing-bundle.mjs';
import { prepareSignedPayload } from '../tools/supervisor-native/release-payload.mjs';

const owned: string[] = [], sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const identity = { GITHUB_SHA: '1'.repeat(40), GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.41.1', GITHUB_REPOSITORY: 'Particle-Academy/prism-acp-ts', REQUIRE_SUPERVISOR_SIGNING: 'true' };
const configured = { ...identity, AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111', AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222', AZURE_SUBSCRIPTION_ID: '33333333-3333-3333-3333-333333333333', ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net', ARTIFACT_SIGNING_ACCOUNT: 'renaissance-analytics', ARTIFACT_SIGNING_PROFILE: 'genie-public' };
afterEach(() => { for (const root of owned.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function staged() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-signing-bundle-')); owned.push(root);
  const bundle = path.join(root, 'bundle'), record = stageSigningBundle(bundle, identity);
  return { root, bundle, record };
}
describe('immutable verifier authorization before publisher identity use', () => {
  it('stages unsigned inputs without identity configuration even when the repository requires signing', () => {
    const { bundle, record } = staged(); expect(record.files).toBe(12); expect(verifySigningBundle(bundle).files).toBe(12);
    const receipt = JSON.parse(fs.readFileSync(path.join(bundle, 'unsigned/release-supervisors.json'), 'utf8'));
    expect(receipt.required).toBe(false);
    const code = fs.readFileSync(path.join(bundle, 'dist/authenticode.js'), 'utf8');
    expect([...code.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1])).toEqual(['node:crypto']);
    expect(code).not.toMatch(/\b(?:require\s*\(|import\s*\()/);
  });
  it('prepares signed copies from a verified unsigned receipt without changing staged inputs', () => {
    const { root, bundle, record } = staged(), file = path.join(bundle, 'unsigned/release-supervisors.json'), before = fs.readFileSync(file);
    expect(prepareSignedPayload({ nativeRoot: path.join(bundle, 'native'), unsignedRoot: path.join(bundle, 'unsigned'), outputRoot: path.join(root, 'signed'), env: configured, version: '0.41.1', expectedReceipt: record.unsignedSha256 })).toEqual({ required: true });
    expect(fs.readFileSync(file)).toEqual(before); expect(verifySigningBundle(bundle).files).toBe(12);
  });
  it('refuses changed verifier code before any downloaded module executes', () => {
    const { bundle } = staged(); fs.appendFileSync(path.join(bundle, 'dist/authenticode.js'), '\nthrow new Error("owned tamper");');
    expect(() => verifySigningBundle(bundle)).toThrow('Reviewed verifier bytes');
  });
  it('refuses a producer-rehashed malicious verifier manifest before import, despite token-request canaries', () => {
    const { root, bundle } = staged(), module = 'dist/authenticode.js', file = path.join(bundle, module), marker = path.join(root, 'executed');
    fs.writeFileSync(file, 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(marker) + ', process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);');
    const manifestFile = path.join(bundle, 'verifier-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.files.find((r: any) => r.file === module).sha256 = sha(fs.readFileSync(file)); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const env: NodeJS.ProcessEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://owned.invalid/', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'owned-canary' };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [path.join(bundle, 'tools/supervisor-native/verify-signing-bundle.mjs'), bundle], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Reviewed verifier manifest required'); expect(fs.existsSync(marker)).toBe(false);
  });
  it('refuses unrecorded packages or code in the signer bundle', () => {
    const { bundle } = staged(); fs.mkdirSync(path.join(bundle, 'node_modules')); fs.writeFileSync(path.join(bundle, 'node_modules/unreviewed.mjs'), 'throw 1;');
    expect(() => verifySigningBundle(bundle)).toThrow('Closed signing bundle');
  });
  it('refuses producer-rehashed arbitrary executable bytes before staging a signed copy', () => {
    const { root, bundle } = staged(), receiptFile = path.join(bundle, 'unsigned/release-supervisors.json'), receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const row = receipt.rows[0], imageFile = path.join(bundle, 'unsigned', row.file), bytes = fs.readFileSync(imageFile); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(imageFile, bytes); row.sha256 = sha(bytes); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const outputRoot = path.join(root, 'signed');
    expect(() => prepareSignedPayload({ nativeRoot: path.join(bundle, 'native'), unsignedRoot: path.join(bundle, 'unsigned'), outputRoot, env: configured, version: '0.41.1', expectedReceipt: sha(fs.readFileSync(receiptFile)) })).toThrow('digest');
    expect(fs.existsSync(outputRoot)).toBe(false);
  });
  it('refuses a producer-rehashed receipt from a different commit even for correct unsigned images', () => {
    const { root, bundle } = staged(), receiptFile = path.join(bundle, 'unsigned/release-supervisors.json'), receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    receipt.commit = '2'.repeat(40); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    const outputRoot = path.join(root, 'signed');
    expect(() => prepareSignedPayload({ nativeRoot: path.join(bundle, 'native'), unsignedRoot: path.join(bundle, 'unsigned'), outputRoot, env: configured, version: '0.41.1', expectedReceipt: sha(fs.readFileSync(receiptFile)) })).toThrow();
    expect(fs.existsSync(outputRoot)).toBe(false);
  });
});
