import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexDriver } from '../src/codex/driver.js';
import { CommandUnsupported } from '../src/codex/commands.js';
import { ClaudeToAcp } from '../src/claude/to-acp.js';
import { AcpAgent, type DriverEvents } from '../src/acp/agent.js';
import { JsonRpcPeer } from '../src/jsonrpc.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { META_COMMAND_CATALOG, META_FILE_EDITS, META_NATIVE_ITEM, META_NATIVE_ITEM_TYPE, META_NATIVE_METHOD, META_REPLAY } from '../src/meta.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Native implements CodexTransport {
  readonly sent: Record<string, any>[] = [];
  readonly held: Record<string, any>[] = [];
  holdCommand = false;
  commandError: { code: number; message: string } | null = null;
  malformedReview = false;
  compactReply: unknown = {};
  closes = 0;
  constructor(readonly handlers: CodexTransportHandlers, readonly version: string) {}
  async start() {}
  send(raw: unknown) {
    const f = raw as Record<string, any>; this.sent.push(f);
    if (typeof f.id !== 'number' || !f.method) return;
    if (f.method === 'review/start' || f.method === 'thread/compact/start') {
      if (this.holdCommand) { this.held.push(f); return; }
      if (this.commandError) { queueMicrotask(() => this.frame({ id: f.id, error: this.commandError })); return; }
    }
    const result = f.method === 'initialize' ? { userAgent: `codex_cli_rs/${this.version} windows` }
      : f.method === 'thread/start' ? { thread: { id: 'thread-one' } }
      : f.method === 'thread/resume' ? { thread: { id: f.params.threadId } }
      : f.method === 'thread/turns/list' ? { data: [{ id: 'history-turn' }], nextCursor: null }
      : f.method === 'thread/items/list' ? { data: [{ item: { type: 'fileChange', id: 'history-edit', changes: [{ path: 'owned.txt', kind: { type: 'add' }, diff: 'HISTORY\n' }], status: 'completed' } }], nextCursor: null }
      : f.method === 'turn/start' ? { turn: { id: 'ordinary-turn' } }
      : f.method === 'review/start' ? { turn: { id: 'review-turn' }, reviewThreadId: this.malformedReview ? 'foreign' : 'thread-one' }
      : f.method === 'thread/compact/start' ? this.compactReply : {};
    queueMicrotask(() => this.frame({ id: f.id, result }));
  }
  frame(value: unknown) { this.handlers.onFrame(value); }
  notify(method: string, params: unknown) { this.frame({ method, params }); }
  end(id: string) { this.notify('turn/completed', { threadId: 'thread-one', turn: { id, status: 'completed' } }); }
  item(item: unknown) { this.notify('item/completed', { threadId: 'thread-one', turnId: 'native-turn', item }); }
  close() { this.closes++; }
}
const drivers: CodexDriver[] = [];
afterEach(() => { for (const driver of drivers.splice(0)) driver.kill(); vi.useRealTimers(); });
async function setup(version = '0.167.0', events: DriverEvents = {}, resume = false) {
  let native!: Native;
  const updates: Record<string, any>[] = [], outcomes: unknown[] = [];
  const driver = new CodexDriver({ cwd: '/owned', ...(resume ? { resumeSessionId: 'thread-one' } : {}) }, {
    ...events, onUpdate: update => { updates.push(update); events.onUpdate?.(update); },
    onTurnEnd: outcome => { outcomes.push(outcome); events.onTurnEnd?.(outcome); },
  }, (_options, handlers) => native = new Native(handlers, version));
  drivers.push(driver); driver.start(); await driver.ready; return { driver, native, updates, outcomes };
}

describe('native Codex operations, not model slash emulation', () => {
  it('advertises the two measured methods in Claude-shaped commands with honest partial-catalog provenance', async () => {
    const { updates } = await setup();
    const catalog = updates.find(u => u.sessionUpdate === 'available_commands_update')!;
    expect(catalog.availableCommands.map((v: any) => [v.name, v._meta[META_NATIVE_METHOD]])).toEqual([
      ['compact', 'thread/compact/start'], ['review', 'review/start'],
    ]);
    expect(catalog._meta[META_COMMAND_CATALOG]).toMatchObject({ complete: false, cliVersion: '0.167.0' });
  });
  it.each(['0.163.0', '0.167.1', '0.168.0-beta.1', 'unknown'])('does not invent support for %s', async version => {
    const { driver, native, updates } = await setup(version);
    expect(updates.find(u => u.sessionUpdate === 'available_commands_update')?.availableCommands).toBeNull();
    await expect(driver.runCommand('compact')).rejects.toMatchObject({ code: 'command_unsupported', reason: 'unmeasured_cli' });
    expect(native.sent.some(f => f.method === 'thread/compact/start')).toBe(false);
    driver.prompt('ordinary text'); expect(native.sent.some(f => f.method === 'turn/start')).toBe(true);
  });
  it('runs compact natively and retains the busy state through acceptance until native completion', async () => {
    const { driver, native, outcomes } = await setup(); await driver.runCommand('compact');
    expect(native.sent.find(f => f.method === 'thread/compact/start')?.params).toEqual({ threadId: 'thread-one' });
    expect(outcomes).toHaveLength(0); expect(() => driver.prompt('overlap')).toThrow('in flight');
    await expect(driver.runCommand('review')).rejects.toMatchObject({ code: 'command_unsupported', reason: 'busy' });
    native.notify('turn/started', { threadId: 'thread-one', turn: { id: 'compact-turn' } });
    native.end('compact-turn'); expect(outcomes).toHaveLength(1);
    driver.prompt('next'); expect(native.sent.filter(f => f.method === 'turn/start')).toHaveLength(1);
  });
  it('runs /review without forwarding any slash text or command/exec host substitute', async () => {
    const { driver, native, outcomes } = await setup(); driver.prompt('/review'); await tick();
    expect(native.sent.find(f => f.method === 'review/start')?.params).toEqual({ threadId: 'thread-one', target: { type: 'uncommittedChanges' }, delivery: 'inline' });
    expect(native.sent.some(f => f.method === 'turn/start' || f.method === 'command/exec')).toBe(false);
    native.end('review-turn'); expect(outcomes).toHaveLength(1);
  });
  it.each(['/unknown', '/compact extra', '/review\nINJECT', '/review /compact'])('refuses %s without sending anything', async content => {
    const { driver, native } = await setup(); const before = native.sent.length;
    expect(() => driver.prompt(content)).toThrow(CommandUnsupported); expect(native.sent).toHaveLength(before);
    driver.prompt('ordinary'); expect(native.sent.at(-1)?.method).toBe('turn/start');
  });
  it('refuses mixed slash content as a whole, and invalid direct names without reflecting their contents', async () => {
    const { driver, native } = await setup(); const before = native.sent.length;
    expect(() => driver.prompt([{ type: 'text', text: '/compact' }, { type: 'image', data: 'abc', mimeType: 'image/png' }])).toThrow(CommandUnsupported);
    await expect(driver.runCommand('SECRET\n/private')).rejects.toThrow('command_unsupported: unknown_command');
    expect(native.sent).toHaveLength(before);
  });
  it('does not bypass command dispatch through empty leading blocks or a leading image', async () => {
    const { driver, native } = await setup();
    expect(() => driver.prompt([{ type: 'image', data: 'abc', mimeType: 'image/png' }, { type: 'text', text: '/compact' }])).toThrow(CommandUnsupported);
    driver.prompt([{ type: 'text', text: '' }, { type: 'text', text: '/compact' }]); await tick();
    expect(native.sent.filter(f => f.method === 'thread/compact/start')).toHaveLength(1);
    expect(native.sent.some(f => f.method === 'turn/start')).toBe(false);
  });
  it('refuses before ready/after close rather than queuing an operation', async () => {
    const d = new CodexDriver({ cwd: '/owned' }); drivers.push(d);
    await expect(d.runCommand('compact')).rejects.toMatchObject({ reason: 'not_ready' });
    const { driver } = await setup(); driver.kill(); await expect(driver.runCommand('review')).rejects.toMatchObject({ reason: 'session_closed' });
  });
  it('remembers native missing-method refusal, updates the menu, sanitizes native error contents, and permits ordinary turns', async () => {
    const { driver, native, updates, outcomes } = await setup(); native.commandError = { code: -32601, message: 'SECRET /private' };
    await expect(driver.runCommand('compact')).rejects.toMatchObject({ code: 'command_unsupported', reason: 'native_method_missing' });
    await expect(driver.runCommand('compact')).rejects.toMatchObject({ reason: 'native_method_missing' });
    expect(native.sent.filter(f => f.method === 'thread/compact/start')).toHaveLength(1);
    expect(updates.filter(u => u.sessionUpdate === 'available_commands_update').at(-1)?.availableCommands.map((v: any) => v.name)).toEqual(['review']);
    expect(JSON.stringify(outcomes)).not.toContain('SECRET'); driver.prompt('still promptable');
  });
  it('closes on a malformed review acknowledgement instead of silently allowing overlapping operations', async () => {
    const { driver, native } = await setup(); native.malformedReview = true;
    await expect(driver.runCommand('review')).rejects.toMatchObject({ code: 'command_unsupported' });
    expect(native.closes).toBe(1); expect(() => driver.prompt('overlap')).toThrow('exited');
  });
  it.each([null, [], { unexpected: true }])('refuses malformed compact acknowledgement %j without opening another operation', async reply => {
    const { driver, native } = await setup(); native.compactReply = reply;
    await expect(driver.runCommand('compact')).rejects.toMatchObject({ code: 'command_unsupported' });
    expect(native.closes).toBe(1); expect(() => driver.prompt('overlap')).toThrow('exited');
  });
  it('does not treat an unexpected native error as proof that execution never started', async () => {
    const { driver, native, outcomes } = await setup(); native.commandError = { code: -32000, message: 'SECRET /private' };
    await expect(driver.runCommand('compact')).rejects.toMatchObject({ code: 'command_unsupported', reason: 'native_refused' });
    expect(native.closes).toBe(1); expect(JSON.stringify(outcomes)).not.toContain('SECRET');
    expect(() => driver.prompt('overlap')).toThrow('exited');
  });
  it('bounds a lost command acknowledgement and closes without replaying it', async () => {
    const { driver, native } = await setup(); vi.useFakeTimers(); native.holdCommand = true;
    const pending = driver.runCommand('compact').catch(error => error); await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toMatchObject({ code: 'command_unsupported' }); expect(native.closes).toBe(1);
    native.frame({ id: native.held[0]!.id, result: {} }); expect(native.sent.filter(f => f.method === 'thread/compact/start')).toHaveLength(1);
  });
  it('does not retarget cancellation before the compact turn ID arrives', async () => {
    const { driver, native } = await setup(); await driver.runCommand('compact');
    const cancellation = driver.cancel(); expect(native.sent.some(f => f.method === 'turn/interrupt')).toBe(false);
    native.notify('turn/started', { threadId: 'other-thread', turn: { id: 'foreign-turn' } });
    expect(native.sent.some(f => f.method === 'turn/interrupt')).toBe(false);
    native.notify('turn/started', { threadId: 'thread-one', turn: { id: 'compact-turn' } }); await cancellation;
    expect(native.sent.find(f => f.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-one', turnId: 'compact-turn' });
  });
  it.each([false, true])('late review acknowledgement (error=%s) cannot overwrite a later ordinary turn', async error => {
    const { driver, native } = await setup(); native.holdCommand = true; const pending = driver.runCommand('review');
    native.notify('turn/started', { threadId: 'thread-one', turn: { id: 'review-turn' } }); native.end('review-turn');
    driver.prompt('later'); await tick();
    const id = native.held[0]!.id;
    native.frame(error ? { id, error: { code: -32601, message: 'SECRET' } } : { id, result: { turn: { id: 'review-turn' }, reviewThreadId: 'thread-one' } });
    if (error) await expect(pending).rejects.toBeInstanceOf(CommandUnsupported); else await pending;
    expect(driver.steeringState.activeTurnId).toBe('ordinary-turn'); expect(() => driver.prompt('overlap')).toThrow('in flight');
  });
});

describe('ACP command refusals remain typed', () => {
  it.each([false, true])('returns command_unsupported for native refusal=%s and leaves no hung ACP prompt', async nativeRefusal => {
    const sent: Record<string, any>[] = []; let native!: Native; let driver!: CodexDriver;
    const peer = new JsonRpcPeer({ send: frame => sent.push(frame) });
    new AcpAgent(peer, { newSessionId: () => 'owned', driverFactory: (_options, events) => {
      driver = new CodexDriver({ cwd: '/owned' }, events, (_config, handlers) => native = new Native(handlers, '0.167.0')); drivers.push(driver); return driver;
    } });
    const call = async (id: number, method: string, params: unknown) => { await peer.receive({ jsonrpc: '2.0', id, method, params }); return sent.find(f => f.id === id)!; };
    await call(1, 'session/new', { cwd: '/owned' }); await driver.ready;
    if (nativeRefusal) native.commandError = { code: -32601, message: 'SECRET /private' };
    const reply = await call(2, 'session/prompt', { sessionId: 'owned', prompt: [{ type: 'text', text: nativeRefusal ? '/compact' : '/unknown' }] });
    expect(reply.error.code).toBe(-32602); expect(reply.error.message).toBe('command_unsupported');
    expect(reply.error.data).toMatchObject({ code: 'command_unsupported', reason: nativeRefusal ? 'native_method_missing' : 'unknown_command' });
    expect(JSON.stringify(reply)).not.toContain('SECRET'); expect(native.sent.some(f => f.method === 'turn/start')).toBe(false);
  });
});

describe('native tool identity and shared edits', () => {
  it.each([
    ['commandExecution', 'shell', { command: 'CONTROL', exitCode: 0 }],
    ['mcpToolCall', 'owned.ping', { server: 'owned', tool: 'ping', arguments: { n: 1 }, result: { content: [] } }],
    ['dynamicToolCall', 'native-name', { tool: 'native-name', arguments: {} }],
    ['fileChange', 'edit', { changes: [{ path: '/owned/file.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-OLD\n+NEW\n' }] }],
  ])('preserves %s identity and detached native shape', async (type, name, fields) => {
    const { native, updates } = await setup(); const item = { type, id: 'item-one', status: 'completed', ...fields };
    native.item(item); const mapped = updates.find(u => u.toolCallId === 'item-one')!;
    expect(mapped.name).toBe(name); expect(mapped._meta[META_NATIVE_ITEM_TYPE]).toBe(type); expect(mapped._meta[META_NATIVE_ITEM]).toEqual(item);
    mapped._meta[META_NATIVE_ITEM].status = 'CLIENT_MUTATION'; expect(item.status).toBe('completed');
    if (type === 'fileChange') {
      const edit = mapped._meta[META_FILE_EDITS][0]; expect(edit).toMatchObject({ path: 'file.txt', kind: 'update', diff: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-OLD\n+NEW\n' });
      expect(Object.hasOwn(edit, 'oldText')).toBe(false); expect(Object.hasOwn(edit, 'newText')).toBe(false);
    }
  });
  it('does not fabricate an MCP name when the native server is absent', async () => {
    const { native, updates } = await setup(); native.item({ type: 'mcpToolCall', id: 'no-server', tool: 'ping' });
    expect(updates.find(u => u.toolCallId === 'no-server')).not.toHaveProperty('name');
  });
  it('does not turn an empty native dynamic tool name into a machine lookup key', async () => {
    const { native, updates } = await setup(); native.item({ type: 'dynamicToolCall', id: 'empty-tool', tool: '' });
    expect(updates.find(u => u.toolCallId === 'empty-tool')).not.toHaveProperty('name');
  });
  it('keeps unrepresentable foreign paths in raw/native data and reports the missing typed edit', async () => {
    const { native, updates } = await setup(); const changes = [{ path: '/outside/owned.txt', kind: { type: 'add' }, diff: 'PRIVATE_CONTROL' }];
    native.item({ type: 'fileChange', id: 'foreign-edit', changes }); const mapped = updates.find(u => u.toolCallId === 'foreign-edit')!;
    expect(mapped.rawInput).toEqual(changes); expect(mapped._meta[META_NATIVE_ITEM].changes).toEqual(changes);
    expect(mapped._meta).not.toHaveProperty(META_FILE_EDITS); expect(updates.some(u => u._meta?.['particle.academy/unmapped_frame'])).toBe(true);
  });
  it('uses the same name/edit/native mapping for historical file items with explicit replay provenance', async () => {
    const { updates } = await setup('0.167.0', {}, true); const mapped = updates.find(u => u.toolCallId === 'history-edit')!;
    expect(mapped.name).toBe('edit'); expect(mapped._meta[META_REPLAY]).toBe(true);
    expect(mapped._meta[META_FILE_EDITS][0]).toMatchObject({ kind: 'add', newText: 'HISTORY\n' });
  });
  it.each(['Edit', 'MultiEdit'])('projects Claude %s exact fragments without pretending they are whole files', name => {
    const mapper = new ClaudeToAcp('/owned');
    const frame = (event: unknown) => mapper.frame({ type: 'stream_event', event });
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'claude-edit', name, input: {} } });
    const input = name === 'Edit' ? { file_path: '/owned/file.txt', old_string: 'old fragment', new_string: 'new fragment' }
      : { file_path: '/owned/file.txt', edits: [{ old_string: 'old fragment', new_string: 'new fragment' }] };
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    const mapped = frame({ type: 'content_block_stop', index: 0 })[0]!;
    expect(mapped.rawInput).toEqual(input); expect((mapped._meta as any)[META_FILE_EDITS][0]).toMatchObject({ path: 'file.txt', kind: 'update', oldText: 'old fragment', newText: 'new fragment', textScope: 'fragment' });
    expect((mapped._meta as any)[META_FILE_EDITS][0]).not.toHaveProperty('movePath');
  });
});
