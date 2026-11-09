import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync('.github/workflows/publish.yml', 'utf8').replace(/\r\n/g, '\n');
function checkGraph(text: string): void {
  // actionlint separately validates complete YAML/expression semantics.
  const jobs = new Map([...text.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  const guard = jobs.get('guard')!, native = jobs.get('native-supervisor')!, signer = jobs.get('sign-supervisor')!, publish = jobs.get('publish')!;
  expect(guard).toContain('require-signing: ${{ steps.signing-policy.outputs.required }}'); expect(guard).not.toContain('environment: release');
  expect(guard.indexOf('node .third-party-allowlist/third-party/check.mjs --repo .')).toBeGreaterThan(0);
  expect(guard.indexOf('run: node tools/supervisor-native/signing-policy.mjs')).toBeGreaterThan(guard.indexOf('node .third-party-allowlist/third-party/check.mjs --repo .'));
  expect(native).toMatch(/^    needs: guard$/m); expect(native).not.toMatch(/^    environment:/m); expect(native).not.toContain('id-token:');
  expect(native).toContain('npm ci'); expect(native).toContain('npm run build');
  expect(native.indexOf('node tools/supervisor-native/compare.mjs')).toBeGreaterThan(0);
  expect(native.indexOf('stage-signing-bundle.mjs')).toBeGreaterThan(native.indexOf('node tools/supervisor-native/compare.mjs'));
  expect(native).toContain('name: windows-supervisor-staged');
  expect(signer).toMatch(/^    needs: \[guard, native-supervisor\]$/m); expect(signer).toMatch(/^    if: needs.guard.outputs.require-signing == 'true'$/m);
  expect(signer).toMatch(/^    environment: release$/m); expect(signer).toMatch(/^      id-token: write$/m); expect(signer).toMatch(/^      contents: read$/m);
  expect(signer).not.toMatch(/\bnpm\b|\bnpx\b|\btsc\b|actions\/checkout@|cache:\s*npm/);
  const blocks = signer.split(/^      - /m), loginIndex = blocks.findIndex(step => step.includes('uses: azure/login@'));
  expect(blocks.flatMap(step => [...step.matchAll(/uses: ([^@\s]+)@/g)].map(match => match[1]))).toEqual(['actions/download-artifact', 'azure/login', 'azure/artifact-signing-action', 'actions/upload-artifact']);
  expect(blocks.filter(step => /^\s+run:/m.test(step))).toHaveLength(2);
  expect(loginIndex).toBeGreaterThan(0); expect(blocks[loginIndex + 1]).toContain('uses: azure/artifact-signing-action@');
  const pin = signer.match(/G256_VERIFIER_BOOTSTRAP_SHA256: '([a-f0-9]{64})'/)?.[1];
  expect(pin).toBe(createHash('sha256').update(fs.readFileSync('tools/supervisor-native/verify-signing-bundle.mjs')).digest('hex'));
  expect(signer.indexOf('Get-FileHash -LiteralPath $bootstrap')).toBeLessThan(signer.indexOf('node "$bootstrap"'));
  expect(signer.indexOf('node "$bootstrap"')).toBeLessThan(signer.indexOf('prepare-signed'));
  expect(signer.indexOf('prepare-signed')).toBeLessThan(signer.indexOf('uses: azure/login@'));
  expect(signer.indexOf('release-payload.mjs" finalize')).toBeGreaterThan(signer.indexOf('uses: azure/artifact-signing-action@'));
  expect(signer).toContain('if ($digest -cne $env:G256_VERIFIER_BOOTSTRAP_SHA256)');
  const nativePins = JSON.parse(fs.readFileSync('native/supervisor-manifest.json', 'utf8'));
  for (const arch of ['x64', 'arm64']) expect(signer.match(new RegExp('G256_UNSIGNED_' + arch.toUpperCase() + "_SHA256: '([a-f0-9]{64})'"))?.[1]).toBe(nativePins.binaries[arch].sha256);
  expect(signer).toContain("foreach ($arch in @('x64', 'arm64'))"); expect(signer).toContain('if ($rawDigest -cne $imagePins[$arch])');
  expect(signer.indexOf('Get-FileHash -LiteralPath $image')).toBeGreaterThan(0);
  expect(signer.indexOf('Get-FileHash -LiteralPath $image')).toBeLessThan(signer.indexOf('node "$bootstrap"'));
  expect(signer).toContain('timestamp-rfc3161: http://timestamp.acs.microsoft.com'); expect(signer).toContain('cache-dependencies: false');
  expect(signer).toContain('exclude-environment-credential: true'); expect(signer).toContain('exclude-azure-cli-credential: false');
  expect(signer).toContain('signing-account-name: renaissance-analytics'); expect(signer).toContain('certificate-profile-name: genie-public');
  expect(signer).not.toMatch(/secrets\.|azure-client-secret:|creds:/);
  for (const step of blocks.filter(step => /uses: azure\//.test(step))) expect(step).toMatch(/uses: azure\/[a-z-]+@[a-f0-9]{40}/);
  for (const step of blocks.filter(step => /uses: actions\//.test(step))) expect(step).toMatch(/uses: actions\/[a-z-]+@[a-f0-9]{40}/);
  expect(publish).toMatch(/^    needs: \[guard, native-supervisor, sign-supervisor\]$/m); expect(publish).not.toMatch(/^    environment:/m);
  expect(publish).toContain("if: always() && needs.guard.result == 'success' && needs.native-supervisor.result == 'success'");
  expect(publish).toContain("needs.guard.outputs.require-signing != 'true' || needs.sign-supervisor.result == 'success'");
  expect(publish).toContain('needs.sign-supervisor.outputs.payload-sha256'); expect(publish).toContain('needs.native-supervisor.outputs.unsigned-sha256');
  expect(publish).toContain('name: windows-supervisor-release'); expect(publish).toContain('name: windows-supervisor-staged');
  expect(publish).toContain("if: needs.guard.outputs.require-signing != 'true'");
  const install = publish.indexOf('release-payload.mjs install'), pack = publish.indexOf('npm pack --ignore-scripts'), packed = publish.indexOf('verify-pack.mjs');
  expect(install).toBeGreaterThan(0); expect(pack).toBeGreaterThan(install); expect(packed).toBeGreaterThan(pack);
  expect(publish.indexOf('publish "$RUNNER_TEMP/g256-pack/"*.tgz')).toBeGreaterThan(packed);
}
describe('isolated publisher signing job graph', () => {
  it('separates dependency/build code from the Azure identity and pins every privileged verifier', () => checkGraph(workflow));
  it.each([
    ['pre-gate signing policy', (s: string) => s.replace('      - name: Fetch the third-party allowlist', '      - run: node tools/supervisor-native/signing-policy.mjs\n      - name: Fetch the third-party allowlist')],
    ['privileged producer', (s: string) => s.replace('      contents: read\n    outputs:\n      unsigned-sha256:', '      contents: read\n      id-token: write\n    outputs:\n      unsigned-sha256:')],
    ['producer environment', (s: string) => s.replace('name: Reproduce exact reviewed Windows payloads from this tag', 'name: Reproduce exact reviewed Windows payloads from this tag\n    environment: release')],
    ['identity-bearing dependency install', (s: string) => s.replace('      - name: Download this run\'s staged unsigned inputs', '      - run: npm ci\n      - name: Download this run\'s staged unsigned inputs')],
    ['signing node cache', (s: string) => s.replace('      - name: Download this run\'s staged unsigned inputs', '      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n          cache: npm\n      - name: Download this run\'s staged unsigned inputs')],
    ['signer checkout', (s: string) => s.replace('      - name: Download this run\'s staged unsigned inputs', '      - uses: actions/checkout@v4\n      - name: Download this run\'s staged unsigned inputs')],
    ['another privileged action', (s: string) => s.replace('      - name: Download this run\'s staged unsigned inputs', '      - uses: actions/cache@' + '1'.repeat(40) + '\n      - name: Download this run\'s staged unsigned inputs')],
    ['unconditional signing job', (s: string) => s.replace("    if: needs.guard.outputs.require-signing == 'true'", '    if: always()')],
    ['unpinned bootstrap', (s: string) => s.replace(/G256_VERIFIER_BOOTSTRAP_SHA256: '[a-f0-9]{64}'/, "G256_VERIFIER_BOOTSTRAP_SHA256: 'unreviewed'")],
    ['unchecked bootstrap', (s: string) => s.replace('if ($digest -cne $env:G256_VERIFIER_BOOTSTRAP_SHA256)', 'if ($false)')],
    ['unreviewed x64 image', (s: string) => s.replace(/G256_UNSIGNED_X64_SHA256: '[a-f0-9]{64}'/, "G256_UNSIGNED_X64_SHA256: 'unreviewed'")],
    ['unreviewed ARM64 image', (s: string) => s.replace(/G256_UNSIGNED_ARM64_SHA256: '[a-f0-9]{64}'/, "G256_UNSIGNED_ARM64_SHA256: 'unreviewed'")],
    ['unchecked executable bytes', (s: string) => s.replace('if ($rawDigest -cne $imagePins[$arch])', 'if ($false)')],
    ['step after login', (s: string) => s.replace('      - name: Publisher sign both reproduced supervisor copies', '      - run: node unreviewed.mjs\n      - name: Publisher sign both reproduced supervisor copies')],
    ['missing signed dependency', (s: string) => s.replace('needs: [guard, native-supervisor, sign-supervisor]', 'needs: [guard, native-supervisor]')],
    ['missing packed-byte check', (s: string) => s.replace('node tools/supervisor-native/verify-pack.mjs', 'echo skipped-verification')],
    ['unpinned signer', (s: string) => s.replace(/azure\/artifact-signing-action@[a-f0-9]{40}/, 'azure/artifact-signing-action@v2')],
  ])('detects broken %s', (_name, mutate) => expect(() => checkGraph(mutate(workflow))).toThrow());
});
