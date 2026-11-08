import { describe, expect, it } from 'vitest';
import { encodeLine, MAX_LINE_BYTES, parseLine } from '../src/ndjson.js';
import { CodexDriver } from '../src/codex/driver.js';
import type { CodexTransportHandlers } from '../src/codex/transport.js';
import { META_FILE_EDITS, META_NATIVE_ITEM, META_NATIVE_ITEM_TYPE, META_OMITTED, projectBudgetedToolMeta, withBudgetedToolMeta, withMeta } from '../src/meta.js';

const base = () => ({ sessionUpdate: 'tool_call_update', toolCallId: 'owned', name: 'edit', status: 'completed',
  rawInput: { control: 'OWNED_INPUT' }, rawOutput: { control: 'OWNED_OUTPUT' }, content: [{ type: 'text', text: 'OWNED_CONTENT' }],
  _meta: { [META_NATIVE_ITEM_TYPE]: 'fileChange', existing: true } });
const edits = [{ path: 'owned.txt', kind: 'update', diff: '--- a/owned.txt\n+++ b/owned.txt\n@@ -1 +1 @@\n-OLD\n+NEW\n', textScope: 'file' }];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('additive tool metadata respects the existing frame budget', () => {
  it('keeps every ordinary additive field and leaves the base unchanged', () => {
    const original = base(), native = { type: 'fileChange', control: 'OWNED_NATIVE' };
    const result = withBudgetedToolMeta(original, { [META_NATIVE_ITEM]: native, [META_FILE_EDITS]: edits });
    expect(result._meta[META_NATIVE_ITEM]).toBe(native); expect(result._meta[META_FILE_EDITS]).toBe(edits);
    expect(result._meta).not.toHaveProperty(META_OMITTED); expect(result.rawInput).toBe(original.rawInput);
    expect(result.rawOutput).toBe(original.rawOutput); expect(result.content).toBe(original.content);
    expect(original._meta).toEqual({ [META_NATIVE_ITEM_TYPE]: 'fileChange', existing: true });
  });
  it('drops the debug copy first, retaining the complete useful edit list whenever it fits', () => {
    const original = base(), native = { control: 'SECRET_CONTROL'.repeat(1000) }, additions = { [META_NATIVE_ITEM]: native, [META_FILE_EDITS]: edits };
    const expectedBytes = bytes(withMeta(original, additions));
    const result = withBudgetedToolMeta(original, additions, 1024);
    expect(result._meta).not.toHaveProperty(META_NATIVE_ITEM); expect(result._meta[META_FILE_EDITS]).toBe(edits);
    expect(result._meta[META_OMITTED]).toEqual({ native_item: 'frame_budget', frameBytes: expectedBytes });
    expect(bytes(result)).toBeLessThanOrEqual(1024); expect(JSON.stringify(result._meta[META_OMITTED])).not.toContain('SECRET_CONTROL');
    expect(result.rawInput).toBe(original.rawInput); expect(result.rawOutput).toBe(original.rawOutput); expect(result.content).toBe(original.content);
    expect(result.name).toBe(original.name); expect(result._meta[META_NATIVE_ITEM_TYPE]).toBe('fileChange');
  });
  it('drops both oversized payloads whole, never a partial or empty edit list', () => {
    const original = base(), largeEdits = [...edits, { path: 'second.txt', kind: 'add', newText: 'A'.repeat(2000), diff: 'A'.repeat(2000) }];
    const result = withBudgetedToolMeta(original, { [META_NATIVE_ITEM]: { large: 'B'.repeat(3000) }, [META_FILE_EDITS]: largeEdits }, 1024);
    expect(result._meta).not.toHaveProperty(META_NATIVE_ITEM); expect(result._meta).not.toHaveProperty(META_FILE_EDITS);
    expect(result._meta[META_OMITTED]).toMatchObject({ native_item: 'frame_budget', file_edits: 'frame_budget' });
    expect(bytes(result)).toBeLessThanOrEqual(1024); expect(largeEdits).toHaveLength(2);
    expect(result.rawInput).toBe(original.rawInput); expect(result.rawOutput).toBe(original.rawOutput); expect(result.content).toBe(original.content);
  });
  it('marks only the file edits when Claude has no native-item debug copy', () => {
    const original = base(); const result = withBudgetedToolMeta(original, { [META_FILE_EDITS]: [{ diff: 'A'.repeat(2000) }] }, 1024);
    expect(result._meta).not.toHaveProperty(META_FILE_EDITS);
    expect(Object.keys(result._meta[META_OMITTED] as object).sort()).toEqual(['file_edits', 'frameBytes']);
    expect(result._meta[META_OMITTED]).toMatchObject({ file_edits: 'frame_budget' });
  });
  it('budgets UTF-8 bytes rather than UTF-16 code units', () => {
    const original = base(), additions = { [META_NATIVE_ITEM]: { control: '日'.repeat(700) } };
    const full = withMeta(original, additions); expect(JSON.stringify(full).length).toBeLessThan(2048); expect(bytes(full)).toBeGreaterThan(2048);
    const result = withBudgetedToolMeta(original, additions, 2048);
    expect(result._meta).not.toHaveProperty(META_NATIVE_ITEM);
    expect(result._meta[META_OMITTED]).toEqual({ native_item: 'frame_budget', frameBytes: bytes(full) });
  });
  it('accepts the real 32 MB comparative image frame with all legacy values identical', () => {
    const rawOutput = { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(32_100_000) }] };
    const original = { sessionUpdate: 'tool_call_update', toolCallId: 'owned-image', name: 'owned.image', rawInput: {}, rawOutput,
      _meta: { [META_NATIVE_ITEM_TYPE]: 'mcpToolCall' } };
    const native = { type: 'mcpToolCall', id: 'owned-image', server: 'owned', tool: 'image', arguments: {}, result: rawOutput };
    const result = withBudgetedToolMeta(original, { [META_NATIVE_ITEM]: native });
    expect(Object.is(result.rawOutput, rawOutput)).toBe(true); expect(Object.is(result.rawInput, original.rawInput)).toBe(true);
    expect(result.name).toBe(original.name); expect(result._meta[META_NATIVE_ITEM_TYPE]).toBe('mcpToolCall');
    expect(result._meta).not.toHaveProperty(META_NATIVE_ITEM); expect(result._meta[META_OMITTED]).toMatchObject({ native_item: 'frame_budget' });
    const line = encodeLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'owned-session', update: result } });
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_LINE_BYTES); expect(parseLine(line)?.ok).toBe(true);
  });

  it('returns the byte-identical legacy row and an existing-channel notice at the exact cap edge', async () => {
    const legacy = { sessionUpdate: 'tool_call_update', toolCallId: 'owned-edge', title: 'image', status: 'completed',
      rawInput: {}, rawOutput: { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(63_999_700) }] } };
    const updates: Record<string, any>[] = []; let handlers!: CodexTransportHandlers;
    const driver = new CodexDriver({ cwd: '/owned' }, { onUpdate: u => updates.push(u) }, (_options, h) => {
      handlers = h;
      return { async start() {}, close() {}, send(raw) {
        const f = raw as Record<string, any>; if (typeof f.id !== 'number') return;
        const result = f.method === 'initialize' ? { userAgent: 'codex_cli_rs/0.167.0 windows' }
          : f.method === 'thread/start' ? { thread: { id: 'owned-thread' } } : {};
        queueMicrotask(() => h.onFrame({ id: f.id, result }));
      } };
    });
    try {
    driver.start(); await driver.ready; const before = updates.length;
    handlers.onFrame({ method: 'item/completed', params: { threadId: 'owned-thread', turnId: 'owned-turn',
      item: { type: 'mcpToolCall', id: 'owned-edge', server: 'owned', tool: 'image', status: 'completed', arguments: {}, result: legacy.rawOutput } } });
    const emitted = updates.slice(before); expect(emitted).toHaveLength(2);
    const result = { update: emitted[0]!, notice: emitted[1]! };
    expect(result.update.sessionUpdate).toBe('tool_call_update'); expect(result.update).not.toHaveProperty('name');
    expect(result.update).not.toHaveProperty('_meta');
    const originalLine = encodeLine({ method: 'session/update', params: { sessionId: 'owned-session', update: legacy } });
    const line = encodeLine({ method: 'session/update', params: { sessionId: 'owned-session', update: result.update } });
    expect(line === originalLine).toBe(true); expect(parseLine(line)?.ok).toBe(true);
    expect(result.notice?.sessionUpdate).toBe('notice'); expect(result.notice?._meta[META_OMITTED]).toMatchObject({
      toolCallId: 'owned-edge', fields: ['name', 'native_type', 'native_item', 'file_edits'], reason: 'frame_budget',
    });
    expect(bytes(result.notice)).toBeLessThan(1024);
    } finally { driver.kill(); }
  });
  it('keeps the marker inline just below the description budget edge', () => {
    const legacy = { sessionUpdate: 'tool_call_update', toolCallId: 'owned-inline', rawOutput: 'OWNED' };
    const required = withMeta({ ...legacy, name: 'owned.tool' }, { [META_NATIVE_ITEM_TYPE]: 'mcpToolCall' });
    const additions = { [META_NATIVE_ITEM]: { debug: 'A'.repeat(5000) } };
    const expectedMarker = { native_item: 'frame_budget', frameBytes: bytes(withMeta(required, additions)) };
    const budgetBytes = bytes(withMeta(required, { [META_OMITTED]: expectedMarker })) + 1;
    const result = projectBudgetedToolMeta(legacy, required, additions, { budgetBytes, capBytes: budgetBytes });
    expect(result.notice).toBeUndefined(); expect(result.update).toHaveProperty('name', 'owned.tool');
    expect((result.update as any)._meta[META_OMITTED]).toEqual(expectedMarker);
    expect(bytes(result.update)).toBeLessThan(budgetBytes);
  });
  it('leaves an already oversized legacy base unchanged for its original rejection', () => {
    const legacy = { sessionUpdate: 'tool_call_update', toolCallId: 'owned-oversized', rawOutput: 'A'.repeat(2000) };
    const result = projectBudgetedToolMeta(legacy, { ...legacy, name: 'owned.tool' }, { [META_NATIVE_ITEM]: {} }, { budgetBytes: 900, capBytes: 1024 });
    expect(result.update).toBe(legacy); expect(bytes(result.update)).toBeGreaterThan(1024); expect(result.notice).toBeUndefined();
  });
  it('does not echo an unbounded malformed identifier into the fixed-size notice', () => {
    const legacy = { sessionUpdate: 'tool_call_update', toolCallId: 'PRIVATE'.repeat(100), rawOutput: 'OWNED' };
    const required = withMeta({ ...legacy, name: 'owned.tool' }, { [META_NATIVE_ITEM_TYPE]: 'mcpToolCall' });
    const result = projectBudgetedToolMeta(legacy, required, { [META_NATIVE_ITEM]: { debug: 'A'.repeat(2000) } }, { budgetBytes: bytes(legacy) + 1, capBytes: 4096 });
    expect(result.update).toBe(legacy); expect(result.notice?._meta[META_OMITTED]).toMatchObject({ toolCallId: null });
    expect(JSON.stringify(result.notice)).not.toContain('PRIVATE'); expect(bytes(result.notice)).toBeLessThan(1024);
  });
  it('retains only Claude file-edit omission fields in its edge notice', () => {
    const legacy = { sessionUpdate: 'tool_call_update', toolCallId: 'claude-edge', rawInput: 'A'.repeat(500) };
    const result = projectBudgetedToolMeta(legacy, legacy, { [META_FILE_EDITS]: [{ diff: 'A'.repeat(2000) }] }, {
      budgetBytes: bytes(legacy) + 1, capBytes: 1024, fields: ['file_edits'],
    });
    expect(result.update).toBe(legacy); expect(result.notice?._meta[META_OMITTED]).toMatchObject({ toolCallId: 'claude-edge', fields: ['file_edits'], reason: 'frame_budget' });
  });
});
