import { describe, expect, it } from 'vitest';
import { probeRestrictedClaude } from './fixtures/claude-restricted-native.mjs';

// Native executable is installed at an exact version by CI. No login, subscription or real model turn.
describe.runIf(process.env.PRISM_ACP_CLAUDE_RESTRICTED === '1')('native Claude2.1.311 app MCP only', () => {
  it('runs supplied MCP and refuses native/inherited tools with positive hostile-config controls', async () => {
    const binary = process.env.PRISM_ACP_CLAUDE_BINARY;
    if (!binary) throw new Error('Set PRISM_ACP_CLAUDE_BINARY to native Claude2.1.311');
    const proof = await probeRestrictedClaude(binary);
    expect(proof.scenarios).toHaveLength(8);
    expect(proof.scenarios.every(row => row.stop.verified && row.stop.empty && row.stop.survivors === 0)).toBe(true);
    console.info(JSON.stringify({ nativeRestrictedProof: proof }));
  }, 150_000);
});
