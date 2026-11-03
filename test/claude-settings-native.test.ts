import { describe, expect, it } from 'vitest';
import { ClaudeDriver, prepareProcessTree } from '../dist/index.js';
import { probeClaudeSettings } from './fixtures/claude-settings-native.mjs';

describe.runIf(process.env.PRISM_ACP_CLAUDE_SETTINGS === '1')('native Claude setting sources and strict MCP', () => {
  it('loads explicit hooks and MCP while selecting sources across startup, resume and relaunch', async () => {
    const binary = process.env.PRISM_ACP_CLAUDE_BINARY;
    if (!binary) throw new Error('Set PRISM_ACP_CLAUDE_BINARY to the native Claude executable');
    const proof = await probeClaudeSettings(binary, { ClaudeDriver, prepareProcessTree });
    expect(proof.scenarios).toHaveLength(8);
    expect(proof.scenarios.every(row => row.stop.verified && row.stop.empty && row.stop.survivors === 0)).toBe(true);
    console.info(JSON.stringify({ nativeSettingsProof: proof }));
  }, 150_000);
});
