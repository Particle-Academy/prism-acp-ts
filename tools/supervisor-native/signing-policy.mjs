import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function signingRequired(value = '') {
  if (!['', 'false', 'true'].includes(value)) throw new Error('REQUIRE_SUPERVISOR_SIGNING must be exactly true or false');
  return value === 'true';
}

export function signingConfiguration(env) {
  const required = signingRequired(env.REQUIRE_SUPERVISOR_SIGNING);
  if (!required) return { required: false };
  const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  for (const key of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID']) {
    if (!guid.test(env[key] ?? '')) throw new Error('Missing or invalid signing variable: ' + key);
  }
  if (!/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/?$/.test(env.ARTIFACT_SIGNING_ENDPOINT ?? '')) {
    throw new Error('Missing or invalid signing variable: ARTIFACT_SIGNING_ENDPOINT');
  }
  for (const key of ['ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE']) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(env[key] ?? '')) throw new Error('Missing or invalid signing variable: ' + key);
  }
  return { required: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = signingRequired(process.env.REQUIRE_SUPERVISOR_SIGNING);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub output file required');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'required=' + required + '\n');
}
