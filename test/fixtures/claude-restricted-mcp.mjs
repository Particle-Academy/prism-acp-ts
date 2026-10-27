import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const marker = process.argv[2];
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  appendFileSync(marker, JSON.stringify({ method: frame.method, pid: process.pid, ppid: process.ppid }) + '\n');
  if (frame.id === undefined) return;
  let result;
  if (frame.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Owned stdio fixture', version: '1' } };
  else if (frame.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Owned stdio fixture marker', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (frame.method === 'tools/call') result = { content: [{ type: 'text', text: 'OWNED_STDIO_MCP_SUCCESS' }] };
  process.stdout.write(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Owned method not found' } } : { jsonrpc: '2.0', id: frame.id, result }) + '\n');
});
