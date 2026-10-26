import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [receipt, server] = process.argv.slice(2);
if (!receipt || !server) throw new Error('Owned fixture requires receipt and server name');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  appendFileSync(receipt, JSON.stringify({ server, method: frame.method }) + '\n');
  if (frame.id === undefined) return;
  if (frame.method === 'initialize') send(frame.id, {
    protocolVersion: frame.params.protocolVersion, capabilities: { tools: {}, resources: {} },
    serverInfo: { name: 'prism-native-tools-fixture', version: '1.0.0' },
  });
  else if (frame.method === 'tools/list') send(frame.id, { tools: [{
    name: 'app_ping', description: 'Owned deterministic application tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }] });
  else if (frame.method === 'tools/call') send(frame.id, { content: [{ type: 'text', text: `PRISM_TOOL_${server}` }] });
  else if (frame.method === 'resources/list') send(frame.id, { resources: [{ uri: 'fixture://owned', name: 'Owned resource', mimeType: 'text/plain' }] });
  else if (frame.method === 'resources/templates/list') send(frame.id, { resourceTemplates: [] });
  else if (frame.method === 'resources/read' && frame.params.uri === 'fixture://owned') send(frame.id, {
    contents: [{ uri: 'fixture://owned', mimeType: 'text/plain', text: `PRISM_RESOURCE_${server}` }],
  });
  else if (frame.method === 'ping') send(frame.id, {});
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unknown fixture request' } }) + '\n');
});
