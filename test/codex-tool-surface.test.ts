import { describe, expect, it } from 'vitest';
import { advertisedTools } from './fixtures/codex-tool-surface.js';

describe('model-facing Codex tool audit', () => {
  it('cannot read a missing top-level array as no native tools', () => {
    const body = { input: [{ type: 'additional_tools', tools: [
      { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] },
      { type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent' }] },
    ] }] };
    expect(advertisedTools(body)).toEqual(['collaboration.spawn_agent', 'functions.exec']);
  });

  it('unions ordinary tools, MCP namespaces and additional tool inputs', () => {
    expect(advertisedTools({ tools: [
      { type: 'function', name: 'read_mcp_resource' }, { type: 'web_search' },
      { type: 'namespace', name: 'mcp__app', tools: [{ type: 'function', name: 'ping' }] },
    ], input: [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }] }] }))
      .toEqual(['@web_search', 'functions.exec', 'mcp__app.ping', 'read_mcp_resource']);
  });

  it('refuses a future hosted tool or request field instead of silently ignoring it', () => {
    expect(() => advertisedTools({ tools: [{ type: 'future_native_tool' }], input: [] })).toThrow();
    expect(() => advertisedTools({ input: [], future_callables: [] })).toThrow();
    expect(advertisedTools({ input: [{ type: 'message', role: 'user', content: [] }] })).toEqual([]);
  });

  it.each([
    null, { tools: {}, input: [] }, { tools: [null], input: [] }, { input: {} },
    { input: [{ type: 'future_tool_batch', tools: [] }] },
    { input: [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'app', tools: null }] }] },
    { input: [{ type: 'additional_tools', tools: [{ type: 'function' }] }] },
    { input: [{ type: 'message', tools: [] }] },
    { tools: Array.from({ length: 1001 }, () => ({ type: 'function', name: 'ping' })), input: [] },
  ])('refuses malformed or unreviewed model tool representations %#', (body) => {
    expect(() => advertisedTools(body)).toThrow();
  });
});
