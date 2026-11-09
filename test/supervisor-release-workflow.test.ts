import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync('.github/workflows/publish.yml', 'utf8').replace(/\r\n/g, '\n');
function checkGraph(text: string): void {
  // A structure check alongside actionlint's full YAML/expression validation.
  const jobs = new Map([...text.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
  const guard = jobs.get('guard')!, native = jobs.get('native-supervisor')!, publish = jobs.get('publish')!;
  expect(guard).toContain('require-signing: ${{ steps.signing-policy.outputs.required }}');
  expect(guard).toContain('id: signing-policy'); expect(guard).not.toContain('environment: release');
  expect(native).toMatch(/^    needs: guard$/m); expect(native).toMatch(/^    environment: release$/m);
  expect(native).toMatch(/^      id-token: write$/m); expect(native).toMatch(/^      contents: read$/m);
  const reproduce = native.indexOf('node tools/supervisor-native/compare.mjs');
  const stage = native.indexOf('release-payload.mjs prepare'), login = native.indexOf('uses: azure/login@'), sign = native.indexOf('uses: azure/artifact-signing-action@'), verify = native.indexOf('release-payload.mjs finalize'), upload = native.indexOf('name: windows-supervisor-release');
  expect(reproduce).toBeGreaterThan(0); expect(stage).toBeGreaterThan(reproduce); expect(login).toBeGreaterThan(stage); expect(sign).toBeGreaterThan(login); expect(verify).toBeGreaterThan(sign); expect(upload).toBeGreaterThan(verify);
  for (const step of native.split(/^      - /m).filter(block => /uses: azure\/(?:login|artifact-signing-action)@/.test(block))) {
    expect(step).toContain("if: needs.guard.outputs.require-signing == 'true'"); expect(step).toMatch(/uses: azure\/[a-z-]+@[a-f0-9]{40}/);
  }
  expect(native).toContain('timestamp-rfc3161: http://timestamp.acs.microsoft.com'); expect(native).toContain('cache-dependencies: false');
  expect(native).toContain('signing-account-name: renaissance-analytics'); expect(native).toContain('certificate-profile-name: genie-public');
  expect(native).toContain('endpoint: https://eus.codesigning.azure.net');
  expect(native).toContain('exclude-environment-credential: true'); expect(native).toContain('exclude-azure-cli-credential: false');
  expect(native).not.toMatch(/secrets\.|azure-client-secret:|creds:/);
  expect(publish).toMatch(/^    needs: \[guard, native-supervisor\]$/m); expect(publish).not.toMatch(/^    environment:/m);
  expect(publish).toContain('SUPERVISOR_RELEASE_SHA256: ${{ needs.native-supervisor.outputs.payload-sha256 }}');
  expect(publish).toContain('REQUIRE_SUPERVISOR_SIGNING: ${{ needs.guard.outputs.require-signing }}');
  const download = publish.indexOf('name: windows-supervisor-release'), install = publish.indexOf('release-payload.mjs install');
  const pack = publish.indexOf('npm pack --ignore-scripts'), packed = publish.indexOf('verify-pack.mjs'), pushed = publish.indexOf('publish "$RUNNER_TEMP/g256-pack/"*.tgz');
  expect(download).toBeGreaterThan(0); expect(install).toBeGreaterThan(download); expect(pack).toBeGreaterThan(install);
  expect(packed).toBeGreaterThan(pack); expect(pushed).toBeGreaterThan(packed);
}
describe('publisher signing job graph', () => {
  it('requires tag reproduction, conditional OIDC signing, verified artifact transfer and packed-byte binding', () => checkGraph(workflow));
  it.each([
    ['environment', (s: string) => s.replace('    environment: release\n', '')],
    ['producer identity', (s: string) => s.replace('SUPERVISOR_RELEASE_SHA256: ${{ needs.native-supervisor.outputs.payload-sha256 }}', 'SUPERVISOR_RELEASE_SHA256: unchecked')],
    ['unsigned fallback', (s: string) => s.replace("if: needs.guard.outputs.require-signing == 'true'", "if: always()")],
    ['missing native dependency', (s: string) => s.replace('needs: [guard, native-supervisor]', 'needs: guard')],
    ['unprotected key credential', (s: string) => s.replace('          cache-dependencies: false', '          azure-client-secret: ${{ secrets.KEY }}')],
    ['unpinned signer', (s: string) => s.replace(/azure\/artifact-signing-action@[a-f0-9]{40}/, 'azure/artifact-signing-action@v2')],
    ['missing packed-byte check', (s: string) => s.replace('node tools/supervisor-native/verify-pack.mjs', 'echo skipped-verification')],
  ])('detects broken %s', (_name, mutate) => expect(() => checkGraph(mutate(workflow))).toThrow());
});
