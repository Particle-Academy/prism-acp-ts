import { describe, expect, it } from 'vitest';
import { claudeArgs } from '../dist/index.js';
import { probeClaudeToolRules } from './fixtures/claude-tool-rules-native.mjs';

describe.runIf(process.env.PRISM_ACP_CLAUDE_TOOL_RULES === '1')('actual Claude permission rule parsing', () => {
  it('allows and denies the exact comma-and-space rule passed through compiled claudeArgs', async () => {
    const binary = process.env.PRISM_ACP_CLAUDE_BINARY;
    if (!binary) throw new Error('Set PRISM_ACP_CLAUDE_BINARY to an exact measured native Claude executable');
    const proof = await probeClaudeToolRules(binary, claudeArgs);
    expect(proof.scenarios.map(row => [row.executed, row.denied])).toEqual([[true, false], [true, false], [false, true]]);
    console.info(JSON.stringify({ nativeToolRulesProof: proof }));
  }, 150_000);
});
