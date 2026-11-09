import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preparePayload, finalizePayload } from './release-payload.mjs';
import { verifySigningBundle } from './verify-signing-bundle.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export function stageSigningBundle(outputRoot, env) {
  assert(path.isAbsolute(outputRoot) && !fs.existsSync(outputRoot));
  const manifestFile = path.join(repository, 'tools/supervisor-native/signing-verifier-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const file of [...manifest.files.map(record => record.file), 'tools/supervisor-native/verify-signing-bundle.mjs']) {
    const to = path.join(outputRoot, file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(repository, file), to, fs.constants.COPYFILE_EXCL);
  }
  fs.copyFileSync(manifestFile, path.join(outputRoot, 'verifier-manifest.json'), fs.constants.COPYFILE_EXCL);
  const unsignedEnv = { ...env, REQUIRE_SUPERVISOR_SIGNING: 'false' }, version = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'))).version;
  const options = { nativeRoot: path.join(repository, 'native'), outputRoot: path.join(outputRoot, 'unsigned'), env: unsignedEnv, version };
  preparePayload(options); const receipt = finalizePayload(options);
  const verified = verifySigningBundle(outputRoot);
  return { unsignedSha256: receipt.sha256, verifierManifestSha256: verified.manifestSha256, files: verified.files };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = stageSigningBundle(process.argv[2], process.env); assert(process.env.GITHUB_OUTPUT);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'sha256=' + result.unsignedSha256 + '\n');
  console.log(JSON.stringify({ stagedUnsignedSupervisorBundle: 'PASS', ...result }));
}
