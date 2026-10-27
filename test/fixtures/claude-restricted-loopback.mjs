// Test-only endpoint injection after the production credential filter. The
// native CLI inherits the production LOCAL handles and stays in the same job.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [binary, endpoint, receipt, ...args] = process.argv.slice(2);
if (process.env.ANTHROPIC_API_KEY !== 'owned-restricted-synthetic-key' || new URL(endpoint).hostname !== '127.0.0.1') throw new Error('owned synthetic endpoint required');
writeFileSync(receipt, JSON.stringify({ mcpConfigPath: args[args.indexOf('--mcp-config') + 1] }));
const child = spawn(binary, args, { env: { ...process.env, ANTHROPIC_BASE_URL: endpoint }, stdio: 'inherit', windowsHide: true });
child.once('error', () => { process.exitCode = 2; });
child.once('exit', code => { process.exitCode = code ?? 1; });
