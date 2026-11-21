// Test-only endpoint injection after the production credential filter. The
// native CLI inherits the production LOCAL handles and stays in the same job.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [binary, endpoint, receipt, ...rest] = process.argv.slice(2);
if (process.env.ANTHROPIC_API_KEY !== 'owned-restricted-synthetic-key' || new URL(endpoint).hostname !== '127.0.0.1') throw new Error('owned synthetic endpoint required');
// A host cannot put a second --settings in binaryArgs (G-319: it could follow and replace disableRemoteControl). The
// explicit-settings scenarios therefore hand the bridge the file under a fixture-only name, and the bridge merges it
// into the ONE --settings the driver built, the driver's keys last, so the CLI still sees a single settings source.
const EXPLICIT = '--fixture-explicit-settings=';
const explicitPath = rest.find((arg) => arg.startsWith(EXPLICIT))?.slice(EXPLICIT.length);
const args = rest.filter((arg) => !arg.startsWith(EXPLICIT));
if (explicitPath !== undefined) {
  const index = args.indexOf('--settings');
  if (index < 0) throw new Error('driver --settings required');
  const value = args[index + 1];
  const driver = JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(value, 'utf8'));
  args[index + 1] = JSON.stringify({ ...JSON.parse(readFileSync(explicitPath, 'utf8')), ...driver });
}
writeFileSync(receipt, JSON.stringify({ mcpConfigPath: args[args.indexOf('--mcp-config') + 1] }));
const child = spawn(binary, args, { env: { ...process.env, ANTHROPIC_BASE_URL: endpoint }, stdio: 'inherit', windowsHide: true });
child.once('error', () => { process.exitCode = 2; });
child.once('exit', code => { process.exitCode = code ?? 1; });
