import { describe, expect, it } from 'vitest';
import { ClaudeDriver, prepareProcessTree } from '../dist/index.js';
import { probeClaudeFileOptions } from './fixtures/claude-file-options-native.mjs';

describe.runIf(process.env.PRISM_ACP_CLAUDE_FILE_OPTIONS === '1')('native Claude append files and plugins', () => {
  it('loads literal file/plugin paths and measures native recorded prompts on resume', async () => {
    const binary = process.env.PRISM_ACP_CLAUDE_BINARY;
    if (!binary) throw new Error('Set PRISM_ACP_CLAUDE_BINARY to the native Claude executable');
    const proof = await probeClaudeFileOptions(binary, { ClaudeDriver, prepareProcessTree });
    console.info(JSON.stringify({ nativeFileOptionsProof: proof }));
    expect(proof.failed).toBeNull();
    const measuredRestriction = /^2\.1\.311(?:\s|$)/.test(proof.cliVersion);
    expect(proof.nativeNoneAppendMeasured).toBe(measuredRestriction);
    expect(proof.scenarios).toHaveLength(measuredRestriction ? 8 : 7);
    expect(proof.scenarios.every(row => row.stop.verified && row.stop.empty && row.stop.survivors === 0 && row.configRemoved)).toBe(true);
    expect(proof.pluginNoneRefusals).toHaveLength(2);
    expect(proof.pluginNoneRefusals.every(row => row.refusedBeforeStart)).toBe(true);
  }, 150_000);
});
