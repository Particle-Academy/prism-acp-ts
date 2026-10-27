import { describe, expect, it } from 'vitest';
import { CodexDriver, type CodexDriverOptions } from '../src/codex/driver.js';
import type { CodexTransport, CodexTransportHandlers } from '../src/codex/transport.js';
import { CODEX_NATIVE_TOOLS_NONE } from '../src/index.js';

function setup(options: Partial<CodexDriverOptions> = {}, version = '0.163.0', config: unknown = {
  mcp_servers: { foreign: { command: 'foreign-mcp', args: [] } },
}, behavior: { reportedModel?: string; earlyThreadStarted?: boolean; onUpdate?: (driver: CodexDriver) => void; configError?: string } = {}) {
  const frames: Record<string, unknown>[] = [], problems: string[] = [];
  // Native config/read includes the global launch overrides; explicit feature values below can inject a bad receipt.
  const supplied=config as Record<string,unknown> | null;
  const baseFeatures={plugins:false,remote_plugin:false};
  const effective=options.nativeTools==='none'&&supplied!==null&&typeof supplied==='object'&&!Array.isArray(supplied)
    ? {...supplied,features:supplied.features===undefined?baseFeatures:
      supplied.features!==null&&typeof supplied.features==='object'&&!Array.isArray(supplied.features)
        ? {...baseFeatures,...supplied.features}:supplied.features} : config;
  let launchArgs:readonly string[]|undefined;
  let closes = 0, receive!: CodexTransportHandlers['onFrame'];
  const driver = new CodexDriver({ cwd: 'C:/work', parentEnv: {}, model: 'gpt-5.3-codex', ...options }, {
    onProtocolError: (problem) => problems.push(problem),
    onUpdate: () => behavior.onUpdate?.(driver),
  }, (_options, handlers) => {
    launchArgs=_options.binaryArgs;
    receive = handlers.onFrame;
    return {
      start: async () => {}, close: () => { closes++; },
      send: (raw: unknown) => {
        const frame = raw as Record<string, unknown>; frames.push(frame);
        if (frame.id === undefined) return;
        const params = frame.params as Record<string, unknown> | undefined;
        const result = frame.method === 'initialize' ? { userAgent: `prism-test/${version} (test)` }
          : frame.method === 'config/read' ? { config:effective }
          : frame.method === 'thread/start' || frame.method === 'thread/resume' ? { thread: { id: 'thread-test' }, model: behavior.reportedModel ?? params?.model }
          : frame.method === 'thread/turns/list' ? { data: [], nextCursor: null }
          : frame.method === 'model/list' ? { data: [
            { id: 'gpt-5.3-codex', displayName: 'Measured model' },
            { id: 'gpt-6.1-sol', displayName: 'Unmeasured model', isDefault: true },
          ], nextCursor: null }
          : {};
        queueMicrotask(() => {
          if (frame.method === 'thread/start' && behavior.earlyThreadStarted) receive({ method: 'thread/started', params: { thread: { id: 'thread-test' } } });
          receive(frame.method === 'config/read' && behavior.configError
            ? { id: frame.id, error: { code: -32000, message: behavior.configError } } : { id: frame.id, result });
        });
      },
    } satisfies CodexTransport;
  });
  return { driver, frames, problems, get launchArgs(){return launchArgs;},get closes() { return closes; }, receive: (raw: unknown) => receive(raw) };
}

describe('measured Codex native-tool restriction', () => {
  it('exports an immutable measured support matrix', () => {
    expect(Object.isFrozen(CODEX_NATIVE_TOOLS_NONE)).toBe(true);
    for (const value of Object.values(CODEX_NATIVE_TOOLS_NONE)) expect(Object.isFrozen(value)).toBe(true);
  });
  it('preserves defaults without inspecting or changing native config', async () => {
    const state = setup(); state.driver.start(); await state.driver.ready;
    expect(state.frames.some((f) => f.method === 'config/read')).toBe(false);
    expect((state.frames.find((f) => f.method === 'thread/start')?.params as Record<string, unknown>).config).toBeUndefined();
    expect(state.launchArgs).toBeUndefined();
    state.driver.kill();
  });

  it('disables both plugin startup features only for restricted launch, preserving the interpreter prefix',async()=>{
    const prefix=['/owned/launcher.mjs','--owned-prefix'];
    const restricted=setup({nativeTools:'none',binaryArgs:prefix});restricted.driver.start();await restricted.driver.ready;
    expect(restricted.launchArgs).toEqual([...prefix,'-c','features.plugins=false','-c','features.remote_plugin=false']);
    expect(prefix).toEqual(['/owned/launcher.mjs','--owned-prefix']);restricted.driver.kill();
    const ordinary=setup({binaryArgs:prefix});ordinary.driver.start();await ordinary.driver.ready;
    expect(ordinary.launchArgs).toEqual(prefix);ordinary.driver.kill();
  });

  for(const feature of ['plugins','remote_plugin'])it.each([undefined,true,'false',null])(`refuses an unverifiable startup ${feature}=%s before the first turn`,async(value)=>{
    const state=setup({nativeTools:'none'},'0.163.0',{features:{plugins:false,remote_plugin:false,[feature]:value}});
    state.driver.start();state.driver.prompt('must remain queued');await state.driver.ready;
    expect(state.frames.some(f=>f.method==='thread/start'||f.method==='turn/start')).toBe(false);
    expect(state.problems.join(' ')).toContain(`could not verify startup feature ${feature}=false`);
    expect(state.closes).toBe(1);
  });

  it.each([undefined, 'gpt-6.1-sol', 'future-model'])('refuses unmeasured or implicit model %s before starting', (model) => {
    expect(() => setup({ nativeTools: 'none', model })).toThrow(/nativeTools.*model/i);
  });

  it.each(['other', false, null, {}])('refuses invalid nativeTools %#', (nativeTools) => {
    expect(() => setup({ nativeTools } as unknown as Partial<CodexDriverOptions>)).toThrow(/nativeTools/);
  });

  it.each(['0.164.0', '0.163.0-alpha.1', 'garbled'])('refuses unmeasured CLI %s before a thread or API-key login', async (version) => {
    const state = setup({ nativeTools: 'none' }, version); state.driver.start(); await state.driver.ready;
    expect(state.frames.some((f) => f.method === 'thread/start' || f.method === 'account/login/start')).toBe(false);
    expect(state.problems.join(' ')).toMatch(/nativeTools.*CLI/i);
    expect(state.closes).toBe(1);
  });

  it('restricts fresh sessions and disables inherited servers', async () => {
    const state = setup({ nativeTools: 'none',
      mcpServers: [{ name: 'owned', command: process.execPath, args: [], env: [] }],
    });
    state.driver.start(); await state.driver.ready;
    const config = (state.frames.find((f) => f.method === 'thread/start')?.params as Record<string, unknown>).config as Record<string, unknown>;
    expect(config).toMatchObject({
      features: { shell_tool: false, view_image: false, multi_agent: false, multi_agent_v2: false, apps: false, plugins: false, goals: false, hooks: false },
      tools: { experimental_request_user_input: { enabled: false }, update_plan: { enabled: false } },
      web_search: 'disabled',
      mcp_servers: { owned: { command: process.execPath }, foreign: { enabled: false } },
    });
    state.driver.kill();
  });

  it.each(['thread-test', ''])('refuses every restricted resume before creating a transport (%s)', (resumeSessionId) => {
    let created = false;
    expect(() => new CodexDriver({ cwd: 'C:/work', model: 'gpt-5.3-codex', nativeTools: 'none', resumeSessionId }, {}, () => {
      created = true; throw new Error('must never launch');
    })).toThrow(/resume is not supported with nativeTools:'none'/);
    expect(created).toBe(false);
  });

  it('retains ordinary-mode resume without native restrictions', async () => {
    const state = setup({ resumeSessionId: 'thread-test' }); state.driver.start(); await state.driver.ready;
    expect(state.frames.some((frame) => frame.method === 'thread/resume')).toBe(true);
    expect(state.frames.some((frame) => frame.method === 'thread/start' || frame.method === 'config/read')).toBe(false);
    state.driver.kill();
  });

  it('does not switch a restricted session to an unmeasured model', async () => {
    const state = setup({ nativeTools: 'none' });
    await expect(state.driver.setModel('gpt-6.1-sol')).rejects.toThrow(/nativeTools.*model/i);
    await expect(state.driver.setModel('gpt-5.3-codex')).resolves.toBeUndefined();
  });

  it('offers only measured models in the session picker', async () => {
    const state = setup({ nativeTools: 'none' }); state.driver.start(); await state.driver.ready;
    const picker = await state.driver.modelState();
    expect(picker.availableModels.map((model) => model.modelId)).toEqual(['gpt-5.3-codex']);
    expect(picker.currentModelId).toBe('gpt-5.3-codex');
    state.driver.kill();
  });

  it('snapshots the validated restriction against later caller option mutation', async () => {
    const directOptions = { cwd: 'C:/work', parentEnv: {}, model: 'gpt-5.3-codex', nativeTools: 'none' as CodexDriverOptions['nativeTools'] };
    const driver = new CodexDriver(directOptions);
    directOptions.nativeTools = 'default';
    await expect(driver.setModel('gpt-6.1-sol')).rejects.toThrow(/nativeTools.*model/);
  });

  it('holds reentrant early-notification prompts until the native model is validated', async () => {
    let attempted = false;
    const state = setup({ nativeTools: 'none' }, '0.163.0', {}, {
      reportedModel: 'gpt-6.1-sol', earlyThreadStarted: true,
      onUpdate: (driver) => { if (!attempted) { attempted = true; driver.prompt('must stay queued'); } },
    });
    state.driver.start(); await state.driver.ready;
    expect(attempted).toBe(true);
    expect(state.frames.some((frame) => frame.method === 'turn/start')).toBe(false);
    expect(state.problems.join(' ')).toMatch(/nativeTools.*model/);
    expect(state.closes).toBe(1);
  });

  it('preserves native error redaction instead of forwarding sensitive provider errors', async () => {
    const state = setup({ nativeTools: 'none' }, '0.163.0', {}, { configError: 'SENSITIVE_NATIVE_ERROR_TOKEN' });
    state.driver.start(); await state.driver.ready;
    expect(state.problems.join(' ')).toContain('Codex app-server startup failed');
    expect(state.problems.join(' ')).not.toContain('SENSITIVE_NATIVE_ERROR_TOKEN');
    expect(state.frames.some((frame) => frame.method === 'thread/start')).toBe(false);
  });

  it('closes on an unsupported model reroute instead of continuing under a false restriction', async () => {
    const state = setup({ nativeTools: 'none' }); state.driver.start(); await state.driver.ready;
    state.receive({ method: 'model/rerouted', params: { threadId: 'thread-test', toModel: 'gpt-6.1-sol' } });
    expect(state.closes).toBe(1);
    expect(state.problems.join(' ')).toMatch(/nativeTools.*model/i);
    expect(() => state.driver.prompt('must not start')).toThrow();
  });

  it('refuses unverifiable inherited configuration', async () => {
    const state = setup({ nativeTools: 'none' }, '0.163.0', { mcp_servers: [] }); state.driver.start(); await state.driver.ready;
    expect(state.frames.some((f) => f.method === 'thread/start')).toBe(false);
    expect(state.problems.join(' ')).toMatch(/MCP configuration/);
  });

  it.each([
    { features: { standalone_web_search: true } },
    { features: { memories: true } },
    { features: { future_tool: { enabled: true } } },
    { features: [] },
    { tools: { future_tool: { enabled: false } } },
    { tools: { web_search: { context_size: 'high' } } },
    { tools: [] },
    { model_catalog_json: '/hostile/catalog.json' },
    { browser_use: { enabled: true } },
    { computer_use: {} },
    { code_mode: { excluded_tool_namespaces: [] } },
  ])('refuses unmeasured inherited tool-shaping configuration %# before creating a thread', async (config) => {
    const state = setup({ nativeTools: 'none' }, '0.163.0', config); state.driver.start(); await state.driver.ready;
    expect(state.frames.some((frame) => frame.method === 'thread/start')).toBe(false);
    expect(state.problems.join(' ')).toMatch(/nativeTools.*(unmeasured|could not verify)/);
    expect(state.closes).toBe(1);
  });

  it('accepts measured harmless features and disables inherited known native capabilities last', async () => {
    const state = setup({ nativeTools: 'none' }, '0.163.0', {
      features: { enable_request_compression: true, api_key_model_discovery: true, shell_tool: true, future_tool: false },
      tools: { experimental_request_user_input: { enabled: true }, view_image: true }, web_search: 'live',
    });
    state.driver.start(); await state.driver.ready;
    expect(state.problems).toEqual([]);
    const config = (state.frames.find((frame) => frame.method === 'thread/start')?.params as Record<string, any>).config;
    expect(config.features.shell_tool).toBe(false);
    expect(config.tools).toMatchObject({ experimental_request_user_input: { enabled: false }, view_image: false });
    expect(config.web_search).toBe('disabled');
    state.driver.kill();
  });
});
