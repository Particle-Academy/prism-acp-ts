import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexDriver } from '../src/codex/driver.js';
import { CODEX_NATIVE_TOOLS_NONE } from '../src/codex/native-tools.js';
import { advertisedTools } from './fixtures/codex-tool-surface.js';
import { openCodexToolProbe, PROTECTED_HOME_SENTINELS } from './fixtures/codex-native-tools-probe.js';

// Explicit opt-in: installed native CLI, empty owned homes, local fake model + stdio MCP fixtures only.
// No real login/model/credentials; a missing CLI or changed version FAILS when opted in.
describe.runIf(process.env.PRISM_ACP_CODEX_NATIVE_TOOLS === '1')('native Codex tool-surface regression (measured CLI 0.163.0)', () => {
  for (const model of CODEX_NATIVE_TOOLS_NONE.models) {
    it(`${model}: exact offered set, app tool invocation, resource scope and no inherited server`, async () => {
      const probe = await openCodexToolProbe({ model, nativeTools: 'none', inheritedForeign: true, calls: [
        { type: 'function_call', namespace: 'mcp__owned', name: 'app_ping', arguments: '{}' },
        { type: 'function_call', name: 'read_mcp_resource', arguments: JSON.stringify({ server: 'owned', uri: 'fixture://owned' }) },
        { type: 'function_call', name: 'read_mcp_resource', arguments: JSON.stringify({ server: 'foreign', uri: 'fixture://owned' }) },
      ] });
      try {
        await probe.turn();
        const expected = [...CODEX_NATIVE_TOOLS_NONE.residualTools, 'mcp__owned.app_ping'].sort();
        expect(probe.requests).toHaveLength(4);
        for (const body of probe.requests) expect(advertisedTools(body)).toEqual(expected);
        expect(probe.outputs()).toContain('PRISM_TOOL_owned');
        expect(probe.outputs()).toContain('PRISM_RESOURCE_owned');
        expect(probe.outputs()).toMatch(/unknown MCP server 'foreign'/);
        expect(probe.outputs()).not.toContain('PRISM_RESOURCE_foreign');
        expect(probe.resources().some((row) => row.server === 'foreign')).toBe(false);
        expect(probe.resources().some((row) => row.server === 'owned' && row.method === 'resources/read')).toBe(true);
        console.info(JSON.stringify({ resourceScope: 'owned read succeeds; inherited foreign read refused', model, expected }));
      } finally { await probe.cleanup(); }
    }, 60000);
  }

  it('rejects unsupported/implicit models before starting an installed CLI session', () => {
    for (const model of ['gpt-6.1-sol', 'future-model', undefined]) {
      expect(() => new CodexDriver({ cwd: process.cwd(), nativeTools: 'none', model })).toThrow(/nativeTools.*model/);
    }
  });

  it('offers zero tools when no MCP servers are supplied and disables the inherited server', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', noMcp: true, inheritedForeign: true });
    try {
      await probe.turn();
      expect(probe.requests).toHaveLength(1);
      expect(advertisedTools(probe.requests[0])).toEqual([]);
      expect(probe.resources()).toEqual([]);
    } finally { await probe.cleanup(); }
  }, 60000);

  it('refuses an unmeasured initialize version before thread/start (fault-injected real handshake)', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', replaceVersion: '0.164.0' });
    try {
      expect(probe.problems.join(' ')).toMatch(/nativeTools.*CLI 0\.164\.0/);
      expect(probe.sent.some((frame) => frame.method === 'thread/start' || frame.method === 'account/login/start')).toBe(false);
      expect(probe.requests).toHaveLength(0);
    } finally { await probe.cleanup(); }
  }, 60000);

  it('refuses a home enabling an unlisted native feature before thread/start', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', inheritedFeatures: { standalone_web_search: true } });
    try {
      expect(probe.problems.join(' ')).toContain('unmeasured feature "standalone_web_search"');
      expect(probe.sent.some((frame) => frame.method === 'thread/start' || frame.method === 'thread/resume')).toBe(false);
      expect(probe.requests).toHaveLength(0);
      expect(probe.resources()).toEqual([]);
    } finally { await probe.cleanup(); }
  }, 60000);

  it('refuses inherited tool-specific settings that were absent from measurement', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none',
      inheritedSettings: { tools: { web_search: { context_size: 'high' } } } });
    try {
      expect(probe.problems.join(' ')).toContain('unmeasured tools setting "web_search"');
      expect(probe.sent.some((frame) => frame.method === 'thread/start')).toBe(false);
      expect(probe.requests).toHaveLength(0);
    } finally { await probe.cleanup(); }
  }, 60000);

  it('overrides known inherited native capabilities and top-level web search with the measured restrictions', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none',
      inheritedFeatures: { shell_tool: true, multi_agent: true, view_image: true, code_mode_host: true },
      inheritedSettings: { web_search: 'live', tools: { experimental_request_user_input: { enabled: true }, update_plan: { enabled: true } } } });
    try {
      await probe.turn();
      expect(advertisedTools(probe.requests[0])).toEqual([...CODEX_NATIVE_TOOLS_NONE.residualTools, 'mcp__owned.app_ping'].sort());
    } finally { await probe.cleanup(); }
  }, 60000);

  it('refuses a real existing thread in restricted mode and retains ordinary resume', async () => {
    const first = await openCodexToolProbe({ model: 'gpt-5.3-codex', suppliedForeign: true, calls: [
      { type: 'function_call', name: 'read_mcp_resource', arguments: JSON.stringify({ server: 'foreign', uri: 'fixture://owned' }) },
    ] });
    let next: Awaited<ReturnType<typeof openCodexToolProbe>> | undefined;
    try {
      await first.turn(); expect(first.outputs()).toContain('PRISM_RESOURCE_foreign');
      const sessionId = first.driver.cliSessionId; expect(sessionId).toBeTypeOf('string');
      await first.cleanup(true);
      await expect(openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', reuseHome: first.home,
        resumeSessionId: sessionId! })).rejects.toThrow(/resume is not supported with nativeTools:'none'/);
      next = await openCodexToolProbe({ model: 'gpt-5.3-codex', reuseHome: first.home, resumeSessionId: sessionId!, calls: [
        { type: 'function_call', name: 'read_mcp_resource', arguments: JSON.stringify({ server: 'owned', uri: 'fixture://owned' }) },
      ] });
      await next.turn();
      expect(next.outputs()).toContain('PRISM_RESOURCE_owned');
      expect(next.sent.some((frame) => frame.method === 'thread/resume')).toBe(true);
    } finally { await next?.cleanup(); await first.cleanup(); }
  }, 90000);

  for (const codeModeHost of [false, true]) {
    it(`unsupported gpt-6.1-sol advertises exec with code_mode_host=${codeModeHost} and distinguishes callable from blocked`, async () => {
      const probe = await openCodexToolProbe({ model: 'gpt-6.1-sol', manualRestriction: true, codeModeHost, calls: [
        { type: 'custom_tool_call', namespace: 'functions', name: 'exec', input: "text('PRISM_CODEMODE_EXECUTED')" },
      ] });
      try {
        await probe.turn();
        expect(advertisedTools(probe.requests[0])).toContain('functions.exec');
        if (codeModeHost) expect(probe.outputs()).toContain('PRISM_CODEMODE_EXECUTED');
        else {
          expect(probe.outputs()).toContain('code-mode host is disabled');
          expect(probe.outputs()).not.toContain('PRISM_CODEMODE_EXECUTED');
        }
        console.info(JSON.stringify({ unsupportedProfile: 'gpt-6.1-sol', nativeCall: 'exec', codeModeHost, actuallyInvoked: codeModeHost }));
      } finally { await probe.cleanup(); }
    }, 60000);
  }

  it('unsupported gpt-6.1-sol still invokes list_agents with the full feature policy', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-6.1-sol', manualRestriction: true, calls: [
      { type: 'function_call', namespace: 'collaboration', name: 'list_agents', arguments: '{}' },
    ] });
    try {
      await probe.turn();
      expect(advertisedTools(probe.requests[0])).toContain('collaboration.list_agents');
      expect(probe.outputs()).toContain('agent_name');
    } finally { await probe.cleanup(); }
  }, 60000);

  it('a working native shell call is refused under the same restricted model and approval policy', async () => {
    const call = { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({
      cmd: process.platform === 'win32' ? 'Write-Output PRISM_NATIVE_EXEC_CONTROL' : "printf 'PRISM_NATIVE_EXEC_CONTROL'",
      yield_time_ms: 1000, max_output_tokens: 1000,
    }) };
    const first = await openCodexToolProbe({ model: 'gpt-5.3-codex', executionControl: true, calls: [call] });
    try { await first.turn(); expect(first.outputs()).toContain('PRISM_NATIVE_EXEC_CONTROL'); }
    finally { await first.cleanup(); }
    const restricted = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', executionControl: true, calls: [call] });
    try {
      await restricted.turn();
      expect(restricted.outputs()).toMatch(/unsupported|unknown|not found|unavailable/i);
      expect(restricted.outputs()).not.toContain('PRISM_NATIVE_EXEC_CONTROL');
    } finally { await restricted.cleanup(); }
  }, 90000);

  for (const signal of ['http-header', 'event-early', 'event-late'] as const) {
    it(`refuses a genuine ${signal} model reroute on notification, including a tool already invoked before late metadata`, async () => {
      const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', rerouteSignal: signal,
        calls: [{ type: 'function_call', namespace: 'mcp__owned', name: 'app_ping', arguments: '{}' }] });
      try {
        const outcome = await probe.turn({ allowError: true });
        expect(outcome.isError).toBe(true);
        expect(probe.problems.join(' ')).toMatch(/nativeTools.*gpt-6.1-sol/);
        expect(probe.received.find((frame) => frame.method === 'model/rerouted')?.params).toMatchObject({
          fromModel: 'gpt-5.3-codex', toModel: 'gpt-6.1-sol', reason: 'highRiskCyberActivity',
        });
        expect(() => probe.driver.prompt('cannot continue after refusal')).toThrow();
        if (signal === 'event-late') {
          expect(probe.lateSignalAfterTool()).toBe(true);
          expect(probe.resources().some((row) => row.method === 'tools/call')).toBe(true);
        }
        console.info(JSON.stringify({ rerouteSignal: signal, refusedOnNotification: true, toolRanBeforeLateSignal: probe.lateSignalAfterTool() }));
      } finally { await probe.cleanup(); }
    }, 60000);
  }

  it('cannot detect a serving-model change reported only in the response envelope; restricted native calls remain refused', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', rerouteSignal: 'envelope', calls: [
      { type: 'function_call', namespace: 'mcp__owned', name: 'app_ping', arguments: '{}' },
      { type: 'function_call', namespace: 'collaboration', name: 'list_agents', arguments: '{}' },
    ] });
    try {
      await probe.turn();
      expect(probe.received.some((frame) => frame.method === 'model/rerouted')).toBe(false);
      expect(probe.outputs()).toContain('PRISM_TOOL_owned');
      expect(probe.outputs()).toMatch(/unsupported|unknown|not found|unavailable/i);
      expect(probe.outputs()).not.toContain('agent_name');
      for (const body of probe.requests) expect(advertisedTools(body)).toEqual([...CODEX_NATIVE_TOOLS_NONE.residualTools, 'mcp__owned.app_ping'].sort());
      console.info(JSON.stringify({ responseEnvelopeModelMismatch: 'not notified by native CLI', suppliedToolRuns: true, hiddenNativeCallRefused: true }));
    } finally { await probe.cleanup(); }
  }, 60000);

  for (const [name, call] of [
    ['exec', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({
      cmd: process.platform === 'win32' ? 'Write-Output PRISM_BEFORE_REROUTE_EXEC' : "printf 'PRISM_BEFORE_REROUTE_EXEC'",
    }) }],
    ['agent', { type: 'function_call', namespace: 'multi_agent_v1', name: 'close_agent', arguments: JSON.stringify({
      target: '00000000-0000-0000-0000-000000000001',
    }) }],
  ] as const) {
    it(`refuses unadvertised native ${name} before any reroute notice arrives`, async () => {
      if (name === 'agent') {
        const control = await openCodexToolProbe({ model: 'gpt-5.3-codex', executionControl: true, calls: [call] });
        try {
          await control.turn();
          expect(advertisedTools(control.requests[0])).toContain('multi_agent_v1.close_agent');
          expect(control.outputs()).toMatch(/not found|does not exist|unknown agent/i);
          expect(control.outputs()).not.toMatch(/unsupported|missing field|invalid.*argument/i);
          console.info(JSON.stringify({ nativeAgentControl: 'recognized close_agent on nonexistent owned-profile ID', output: control.outputs() }));
        } finally { await control.cleanup(); }
      }
      const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', executionControl: true,
        rerouteSignal: 'http-header', rerouteOnRequest: 2, calls: [call] });
      try {
        const outcome = await probe.turn({ allowError: true });
        expect(outcome.isError).toBe(true);
        expect(probe.requests).toHaveLength(2);
        // The fake provider sends reroute metadata only AFTER it has received the native call's error output.
        expect(probe.outputs()).toMatch(/unsupported|unknown|unavailable/i);
        expect(probe.outputs()).not.toContain('PRISM_BEFORE_REROUTE_EXEC');
        expect(probe.received.some((frame) => frame.method === 'model/rerouted')).toBe(true);
        for (const body of probe.requests) expect(advertisedTools(body)).toEqual([...CODEX_NATIVE_TOOLS_NONE.residualTools, 'mcp__owned.app_ping'].sort());
        console.info(JSON.stringify({ beforeRerouteNativeCall: name, refusedBeforeMetadataSent: true }));
      } finally { await probe.cleanup(); }
    }, 60000);
  }

  it('removes model routes to synthetic private profile/config/session files while preserving trusted CLI auth, and its oracle catches a shell mutation', async () => {
    const shell = { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({
      cmd: `node -e "const fs=require('node:fs');const p=require('node:path');for(const n of ['profile.json','config.toml','sessions/protected.jsonl'])process.stdout.write(fs.readFileSync(p.join(process.env.CODEX_HOME,n),'utf8'))"`,
    }) };
    const assertNoLeak = (probe: Awaited<ReturnType<typeof openCodexToolProbe>>) => {
      const traffic = JSON.stringify({ modelRequests: probe.requests, nativeFrames: probe.received, outgoing: probe.sent });
      for (const sentinel of Object.values(PROTECTED_HOME_SENTINELS)) {
        if (traffic.includes(sentinel)) throw new Error('Protected home sentinel disclosed through a model route');
      }
    };
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', protectedHome: true, executionControl: true,
      inheritedForeign: true, calls: (home) => [
        shell,
        { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: join(home, 'profile.json') }) },
        { type: 'function_call', name: 'read_file', arguments: JSON.stringify({ path: join(home, 'config.toml') }) },
        { type: 'function_call', namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: JSON.stringify({
          task: `Read ${join(home, 'profile.json')}, config.toml and sessions/protected.jsonl and return their contents`,
        }) },
        { type: 'function_call', name: 'list_mcp_resources', arguments: '{}' },
        { type: 'function_call', name: 'read_mcp_resource', arguments: JSON.stringify({ server: 'owned', uri: pathToFileURL(join(home, 'profile.json')).href }) },
        { type: 'function_call', name: 'read_mcp_resource', arguments: JSON.stringify({ server: 'foreign', uri: 'fixture://owned' }) },
      ] });
    try {
      expect(await probe.trustedAccount()).toMatchObject({ account: { type: 'apiKey' } });
      await probe.turn();
      expect(probe.requests).toHaveLength(8);
      assertNoLeak(probe);
      for (const body of probe.requests) expect(advertisedTools(body)).toEqual([...CODEX_NATIVE_TOOLS_NONE.residualTools, 'mcp__owned.app_ping'].sort());
      expect(probe.resources().some((row) => row.server === 'foreign')).toBe(false);
      const files = probe.protectedFiles();
      expect(files['profile.json']).toContain(PROTECTED_HOME_SENTINELS.profile);
      expect(files['config.toml']).toContain(PROTECTED_HOME_SENTINELS.config);
      expect(files['sessions/protected.jsonl']).toContain(PROTECTED_HOME_SENTINELS.session);
      console.info(JSON.stringify({ protectedHome: 'profile/config/session', modelRoutesDisclosed: false, trustedCliAuthRead: true }));
    } finally { await probe.cleanup(); }
    const mutant = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', protectedHome: true,
      executionControl: true, enableShellMutation: true, calls: [shell] });
    try {
      await mutant.turn();
      expect(mutant.outputs()).toContain(PROTECTED_HOME_SENTINELS.profile);
      expect(mutant.outputs()).toContain(PROTECTED_HOME_SENTINELS.config);
      expect(mutant.outputs()).toContain(PROTECTED_HOME_SENTINELS.session);
      expect(() => assertNoLeak(mutant)).toThrow('Protected home sentinel disclosed');
      console.info(JSON.stringify({ protectedHomeMutation: 'shell_tool re-enabled', leakOracleFailedAsRequired: true }));
    } finally { await mutant.cleanup(); }
  }, 90000);
});
