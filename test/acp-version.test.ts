import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AcpAgent, type AcpAgentOptions } from '../src/acp/agent.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function initialize(agentInfo?: AcpAgentOptions['agentInfo']) {
  const sent: Record<string, unknown>[] = [];
  const peer = new JsonRpcPeer({ send: message => sent.push(message as Record<string, unknown>) });
  new AcpAgent(peer, { driverFactory: () => { throw new Error('initialize must not create a driver'); },
    ...(agentInfo === undefined ? {} : { agentInfo }) });
  await peer.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  return (sent.find(message => message.id === 1)?.result as Record<string, unknown>)?.agentInfo;
}

describe('ACP agent package version', () => {
  it('reports the package version by default', async () => {
    expect(await initialize()).toEqual({ name: '@particle-academy/prism-acp', title: 'Prism ACP', version: manifest.version });
  });

  it('preserves a caller-supplied agent identity and version', async () => {
    const custom = { name: 'owned-application', title: 'Owned application', version: '6.7.8' };
    expect(await initialize(custom)).toEqual(custom);
  });

  it.each([
    { mode: 'present', custom: false, version: '9.8.7' },
    { mode: 'missing', custom: false, version: 'unknown' },
    { mode: 'malformed', custom: false, version: 'unknown' },
    { mode: 'missing', custom: true, version: '6.7.8' },
  ])('initializes a built package with $mode metadata and custom identity $custom', ({ mode, custom, version }) => {
    const dist = fileURLToPath(new URL('../dist', import.meta.url));
    expect(existsSync(join(dist, 'index.js')), 'build before running the native package test').toBe(true);
    const parent = realpathSync(tmpdir());
    const root = mkdtempSync(join(parent, 'prism-acp-version-'));
    try {
      const installed = join(root, 'package'), decoy = join(root, 'working-directory');
      mkdirSync(installed); mkdirSync(decoy);
      // A distinct fixture version catches replacing one hard-coded release with another.
      if (mode === 'present') writeFileSync(join(installed, 'package.json'), JSON.stringify({ ...manifest, version: '9.8.7' }));
      if (mode === 'malformed') writeFileSync(join(installed, 'package.json'), JSON.stringify({ ...manifest, version: '9.8.7' }));
      writeFileSync(join(decoy, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.3' }));
      cpSync(dist, join(installed, 'dist'), { recursive: true });
      const probe = join(root, 'probe.mjs');
      const expected = custom
        ? { name: 'owned-application', title: 'Owned application', version }
        : { name: '@particle-academy/prism-acp', title: 'Prism ACP', version };
      writeFileSync(probe, [
        'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
        `const metadataUrl = ${JSON.stringify(pathToFileURL(join(installed, 'package.json')).href)};`,
        'let metadataReads = 0; const originalRead = fs.readFileSync;',
        'fs.readFileSync = function(file, ...args) { if (file instanceof URL && file.href === metadataUrl) metadataReads++; return originalRead.call(this, file, ...args); };',
        'syncBuiltinESMExports();',
        `const { AcpAgent, JsonRpcPeer } = await import(${JSON.stringify(pathToFileURL(join(installed, 'dist/index.js')).href)});`,
        'const importReads = metadataReads;',
        ...(mode === 'malformed' ? ['fs.writeFileSync(new URL(metadataUrl), \'{"version":\');'] : []),
        'const sent = []; const peer = new JsonRpcPeer({ send: message => sent.push(message) });',
        'new AcpAgent(peer, { driverFactory: () => { throw new Error("unexpected driver"); },'
          + (custom ? 'agentInfo: ' + JSON.stringify(expected) : '') + ' });',
        'await peer.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });',
        'console.log(JSON.stringify({ agentInfo: sent.find(message => message.id === 1).result.agentInfo, importReads, metadataReads }));',
      ].join('\n'));
      const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
        PATH: dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root,
        LOCALAPPDATA: root, TEMP: root, TMP: root, TMPDIR: root, NODE_OPTIONS: '', NODE_PATH: '' };
      const child = spawnSync(process.execPath, [probe], { cwd: decoy, env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.agentInfo).toEqual(expected);
      expect(result.importReads).toBe(0);
      if (custom) expect(result.metadataReads).toBe(0);
    } finally {
      const resolved = realpathSync(root);
      if (dirname(resolved) !== parent || !basename(resolved).startsWith('prism-acp-version-')) throw new Error('owned package fixture root changed');
      rmSync(resolved, { recursive: true, force: true });
    }
  });
});
