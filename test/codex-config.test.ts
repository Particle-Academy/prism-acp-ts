import { describe, expect, it } from 'vitest';
import { CodexDriver, type CodexDriverOptions, type CodexTransportFactory } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';

type Row = Record<string, any>;
function harness(options: CodexDriverOptions & { config?: unknown }) {
  const sent: Row[] = [], problems: string[] = [];
  const factory: CodexTransportFactory = (_launch, handlers: CodexTransportHandlers): CodexTransport => ({
    async start() {}, close() {},
    send(frame: unknown) {
      const request = frame as Row; sent.push(request); if (request.id === undefined) return;
      const result = request.method === 'initialize' ? { userAgent: 'codex/0.163.0' }
        : request.method === 'config/read' ? { config: { features: { plugins: false, remote_plugin: false }, mcp_servers: {} } }
          : request.method === 'thread/start' ? { thread: { id: 'fixture-thread' }, model: request.params.model }
            : request.method === 'thread/resume' ? { thread: { id: request.params.threadId }, model: request.params.model } : {};
      queueMicrotask(() => handlers.onFrame({ id: request.id, result }));
    },
  });
  const driver = new CodexDriver(options, { onProtocolError: problem => problems.push(problem) }, factory);
  return { driver, sent, problems };
}
async function launch(options: CodexDriverOptions & { config?: unknown }) {
  const result = harness(options); result.driver.start(); await result.driver.ready; expect(result.problems).toEqual([]); return result;
}
describe('Codex per-thread configuration', () => {
  for (const resume of [false, true]) it(`passes nested/flat JSON config with owned MCP on ${resume ? 'resume' : 'start'}`, async () => {
    const config = { project_doc_max_bytes: 0, 'skills.config': [{ path: '/fixture/skill/SKILL.md', enabled: false }], examples: { numbers: [1, 0, 1.5], nullable: null, text: 'line\nvalue' } };
    const h = await launch({ cwd: process.cwd(), config, ...(resume ? { resumeSessionId: '01995438-5897-7564-8ea6-739a0f932f56', replayHistory: false } : {}), mcpServers: [{ name: 'owned', command: process.execPath, args: [], env: [] }] });
    const params = h.sent.find(row => row.method === (resume ? 'thread/resume' : 'thread/start'))!.params;
    expect(params.config.project_doc_max_bytes).toBe(0); expect(params.config.skills.config).toEqual(config['skills.config']); expect(params.config.examples).toEqual(config.examples); expect(params.config.mcp_servers.owned.command).toBe(process.execPath);
  });
  it('copies and recursively freezes config at construction across asynchronous and replacement launches', async () => {
    const config = { skills: { config: [{ path: '/original/SKILL.md', enabled: false }] }, value: { nested: [1, true, null] } };
    const first = harness({ cwd: process.cwd(), config }), replacement = harness({ cwd: process.cwd(), config });
    config.skills.config[0].enabled = true; config.skills.config.push({ path: '/late/SKILL.md', enabled: true }); config.value.nested[0] = 42;
    for (const h of [first, replacement]) {
      h.driver.start(); await h.driver.ready; const copied = h.sent.find(row => row.method === 'thread/start')!.params.config;
      expect(copied.skills.config).toEqual([{ path: '/original/SKILL.md', enabled: false }]); expect(copied.value.nested).toEqual([1, true, null]);
      expect(Object.isFrozen(copied.skills.config)).toBe(true); expect(Object.isFrozen(copied.skills.config[0])).toBe(true); expect(Object.isFrozen(copied.value)).toBe(true);
    }
    expect(Object.isFrozen(config)).toBe(false);
  });
  it('omitted config preserves the previous no-config RPC shape', async () => {
    const h = await launch({ cwd: process.cwd() }); expect(h.sent.find(row => row.method === 'thread/start')!.params).not.toHaveProperty('config');
  });
  for (const config of [
    null, [], 'text', 0, new Date(), new Map(), { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: () => 1 }, { value: Symbol('secret') },
    { list: new Array(2) }, Object.assign([1], { extra: 'lost' }), { value: new Set() },
    { value: { toJSON() { throw new Error('never execute'); } } },
    JSON.parse('{"__proto__":{"polluted":true}}'), JSON.parse('{"constructor":true}'),
  ]) it('refuses a non-JSON-safe value before launch without echoing it', () => {
    expect(() => harness({ cwd: process.cwd(), config })).toThrow(/config/);
  });
  it('never invokes accessor hooks and refuses cycles, excessive depth, symbols and oversized input', () => {
    let called = false; const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { called = true; throw new Error('SECRET'); } });
    const cycle: Row = {}; cycle.value = cycle; const deep: Row = {}; let leaf = deep; for (let i = 0; i < 45; i++) leaf = leaf.value = {};
    for (const config of [accessor, cycle, deep, { ['x.'.repeat(34) + 'x']: true }, { [Symbol('key')]: true }, { value: 'x'.repeat(524289) }]) expect(() => harness({ cwd: process.cwd(), config })).toThrow(/config/);
    expect(called).toBe(false);
  });
  it('refuses proxies before evaluating their traps and keeps diagnostics free of values', () => {
    let called = false;
    const proxy = new Proxy({}, { getPrototypeOf() { called = true; throw new Error('SECRET_CANARY'); }, ownKeys() { called = true; throw new Error('SECRET_CANARY'); } });
    for (const config of [proxy, { value: proxy }, { list: new Proxy([], { get() { called = true; throw new Error('SECRET_CANARY'); } }) }]) {
      expect(() => harness({ cwd: process.cwd(), config })).toThrow(/^config must/);
    }
    expect(called).toBe(false);
  });
  for (const config of [
    { mcp_servers: {} }, { 'mcp_servers.owned.command': 'unsafe' }, { '"mcp_servers".owned': {} },
    { shell_environment_policy: {} }, { approval_policy: 'never' }, { sandbox_mode: 'danger-full-access' }, { model: 'other' },
    { model_provider: 'other' }, { model_providers: {} }, { profile: 'unsafe' }, { profiles: {} },
    { features: { shell_snapshot: true } }, { 'features.shell_snapshot': true },
    { features: false }, { skills: {}, 'skills.config': [] },
    { 'mcp_servers\n': {} }, { 'mcp_servers\r': {} },
  ]) it('refuses driver-owned or ambiguous configuration paths', () => {
    expect(() => harness({ cwd: process.cwd(), config })).toThrow(/config/);
  });
  it('merges caller feature values while preserving MCP bearer snapshot and shell exclusions', async () => {
    const h = await launch({ cwd: process.cwd(), config: { features: { enable_request_compression: false } }, mcpServers: [{ type: 'http', name: 'owned', url: 'http://127.0.0.1:1', headers: [{ name: 'Authorization', value: 'Bearer fixture-token' }] }] });
    const config = h.sent.find(row => row.method === 'thread/start')!.params.config;
    expect(config.features).toEqual({ enable_request_compression: false, shell_snapshot: false }); expect(config.shell_environment_policy.exclude).toHaveLength(1); expect(JSON.stringify(config)).not.toContain('fixture-token');
  });
  for (const config of [{ features: { shell_tool: true } }, { tools: {} }, { web_search: 'live' }, { 'skills.include_instructions': true }, { cloud: {} }, { approvals_reviewer: 'auto_review' }, { model_catalog_json: '/file' }]) it('restricted mode rejects configuration that can replace its owned controls', () => {
    expect(() => harness({ cwd: process.cwd(), nativeTools: 'none', model: 'gpt-5.3-codex', config })).toThrow(/config/);
  });
  it('restricted mode preserves generic skills settings alongside its final controls', async () => {
    const h = await launch({ cwd: process.cwd(), nativeTools: 'none', model: 'gpt-5.3-codex', config: { 'skills.config': [{ path: '/fixture/SKILL.md', enabled: false }], 'skills.include_instructions': false, project_doc_max_bytes: 0 } });
    const config = h.sent.find(row => row.method === 'thread/start')!.params.config;
    expect(config.project_doc_max_bytes).toBe(0); expect(config.skills.config).toEqual([{ path: '/fixture/SKILL.md', enabled: false }]); expect(config.skills.include_instructions).toBe(false); expect(config.features.shell_tool).toBe(false); expect(config.web_search).toBe('disabled');
  });
  it('accepts the generic nested and dotted skill instruction setting with or without restriction', async () => {
    for (const restricted of [false, true]) for (const config of [{ skills: { include_instructions: false } }, { 'skills.include_instructions': false }]) {
      const h = await launch({ cwd: process.cwd(), config, ...(restricted ? { nativeTools: 'none' as const, model: 'gpt-5.3-codex' } : {}) });
      expect(h.sent.find(row => row.method === 'thread/start')!.params.config.skills.include_instructions).toBe(false);
    }
  });
});
