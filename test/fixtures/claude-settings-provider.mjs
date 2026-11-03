import fs from 'node:fs';
import readline from 'node:readline';

const [marker, ...args] = process.argv.slice(2);
fs.writeFileSync(marker, JSON.stringify({ args }));
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: frame.request_id,
      response: { claude_code_version: '2.1.312', models: [{ value: 'owned-model', displayName: 'Owned model', description: 'Fixture' }] },
    } }) + '\n');
  }
});
