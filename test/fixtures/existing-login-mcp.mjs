import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const marker = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  let request; try { request = JSON.parse(line); } catch { continue; }
  appendFileSync(marker, JSON.stringify({ method: request.method }) + '\n');
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'owned-existing-login', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'owned_ui_status', description: 'Metadata-only owned UI fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Metadata-only fixture refuses execution' } }) + '\n');
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
