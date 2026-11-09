import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Developer-only explicit source pin update. Never run in the signing job.
const root = fileURLToPath(new URL('../../', import.meta.url));
const write = process.argv[2] === '--write'; assert(write || process.argv[2] === '--check', 'Use --check or --write after npm run build');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = file => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
const generated = canonical('dist/authenticode.js');
assert.deepEqual([...generated.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]), ['node:crypto']);
assert(!/\b(?:require\s*\(|import\s*\()/.test(generated), 'Dependency-free reviewed image verifier required');
const names = ['package.json', 'native/supervisor-manifest.json', 'dist/authenticode.js', 'tools/supervisor-native/release-payload.mjs', 'tools/supervisor-native/signing-policy.mjs', 'tools/supervisor-native/publisher-signature.ps1'].sort();
const manifest = JSON.stringify({ schemaVersion: 1, files: names.map(file => {
  const mode = file.startsWith('native/') ? 'raw' : 'lf';
  return { file, mode, sha256: sha(mode === 'raw' ? fs.readFileSync(path.join(root, file)) : Buffer.from(canonical(file))) };
}) }, null, 2) + '\n';
const manifestHash = sha(Buffer.from(manifest)), bootstrapFile = 'tools/supervisor-native/verify-signing-bundle.mjs';
const bootstrap = canonical(bootstrapFile); assert.equal([...bootstrap.matchAll(/const MANIFEST_SHA256 = '[a-f0-9]{64}';/g)].length, 1);
const pinnedBootstrap = bootstrap.replace(/const MANIFEST_SHA256 = '[a-f0-9]{64}';/, "const MANIFEST_SHA256 = '" + manifestHash + "';");
const bootstrapHash = sha(Buffer.from(pinnedBootstrap)), workflowFile = '.github/workflows/publish.yml', workflow = canonical(workflowFile);
assert.equal([...workflow.matchAll(/G256_VERIFIER_BOOTSTRAP_SHA256: '[a-f0-9]{64}'/g)].length, 1);
let pinnedWorkflow = workflow.replace(/G256_VERIFIER_BOOTSTRAP_SHA256: '[a-f0-9]{64}'/, "G256_VERIFIER_BOOTSTRAP_SHA256: '" + bootstrapHash + "'");
const native = JSON.parse(fs.readFileSync(path.join(root, 'native/supervisor-manifest.json')));
for (const arch of ['x64', 'arm64']) {
  const key = 'G256_UNSIGNED_' + arch.toUpperCase() + '_SHA256', expression = new RegExp(key + ": '[a-f0-9]{64}'", 'g');
  assert.equal([...workflow.matchAll(expression)].length, 1); assert.equal(sha(fs.readFileSync(path.join(root, 'native', native.binaries[arch].file))), native.binaries[arch].sha256);
  pinnedWorkflow = pinnedWorkflow.replace(expression, key + ": '" + native.binaries[arch].sha256 + "'");
}
for (const [file, bytes] of [['tools/supervisor-native/signing-verifier-manifest.json', manifest], [bootstrapFile, pinnedBootstrap], [workflowFile, pinnedWorkflow]]) {
  if (write) fs.writeFileSync(path.join(root, file), bytes);
  else assert.equal(canonical(file), bytes, 'Reviewed verifier pins changed; build, run pin-signing-verifiers.mjs --write, and review all pin diffs');
}
console.log(JSON.stringify({ signingVerifierPins: write ? 'UPDATED_REVIEW_REQUIRED' : 'PASS', files: names.length, manifestHash, bootstrapHash }));
