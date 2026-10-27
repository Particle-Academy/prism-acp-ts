import fs from 'node:fs';
import readline from 'node:readline';

const [mode, marker] = process.argv.slice(2);
const configAt = process.argv.indexOf('--mcp-config');
const state = { config: process.argv[configAt + 1], prompts: 0, initialized: false, promptAfterInitialize: null,
  home: process.env.HOME, profile: process.env.USERPROFILE, configHome: process.env.CLAUDE_CONFIG_DIR,
  inheritedKeyPresent: process.env.ANTHROPIC_API_KEY !== undefined };
const save = () => fs.writeFileSync(marker, JSON.stringify(state));
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
save();
let inputClosed = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
    if (mode === 'pending') return;
    setTimeout(() => {
      state.initialized = true; save();
      if (mode === 'bad-frame') process.stdout.write('not a JSON frame\n');
      if (mode === 'bad-message') send([]);
      const response = { models: mode === 'malformed' ? 'invalid' : [{ value: 'owned-model', displayName: 'Owned model', description: 'Synthetic fixture' }] };
      if (mode !== 'missing-version') response.claude_code_version = mode === 'unknown-version' ? '2.1.999' : '2.1.311';
      send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
      if (inputClosed) process.stdout.write('', () => process.exit(0));
    }, 75);
  } else if (frame.type === 'user') {
    state.prompts++; state.promptAfterInitialize = state.initialized; save();
    const init = { type: 'system', subtype: 'init', claude_code_version: '2.1.311', tools: [], mcp_servers: [] };
    if (mode === 'init-version') init.claude_code_version = '2.1.999';
    if (mode === 'init-missing-tools') delete init.tools;
    if (mode === 'init-native') init.tools = ['Bash'];
    if (mode === 'init-session') init.session_id = '../owned-invalid';
    if (mode === 'init-inherited') { init.tools = ['mcp__inherited__echo']; init.mcp_servers = [{ name: 'inherited', status: 'connected' }]; }
    if (mode !== 'init-missing') send(init);
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'owned' });
  }
});
lines.on('close', () => { inputClosed = true; if (state.initialized) process.stdout.write('', () => process.exit(0)); });
