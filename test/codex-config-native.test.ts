import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openCodexToolProbe } from './fixtures/codex-native-tools-probe.js';
import { advertisedTools } from './fixtures/codex-tool-surface.js';
import { CODEX_NATIVE_TOOLS_NONE } from '../src/codex/native-tools.js';

// Native app-server with owned temporary homes/projects and a loopback Responses
// stand-in. No real credential files, authentication or paid model requests.
describe.runIf(process.env.PRISM_ACP_CODEX_CONFIG === '1')('native Codex per-thread configuration', () => {
  const scenarios = [
    { name: 'default', docs: true, skills: true, allSkills: false },
    { name: 'documents disabled', docs: false, skills: true, allSkills: false },
    { name: 'skill disabled', docs: true, skills: false, allSkills: false },
    { name: 'both disabled', docs: false, skills: false, allSkills: false },
    { name: 'skill instructions disabled', docs: true, skills: false, allSkills: true },
    { name: 'documents and skill instructions disabled', docs: false, skills: false, allSkills: true },
  ];
  for (const resume of [false, true]) for (const scenario of scenarios) it(`${resume ? 'resume' : 'start'}: ${scenario.name}`, async () => {
    let seed: Awaited<ReturnType<typeof openCodexToolProbe>> | undefined, probe: Awaited<ReturnType<typeof openCodexToolProbe>> | undefined;
    let markers: { doc: string; skill: string } | undefined;
    try {
      let sessionId: string | undefined;
      if (resume) {
        seed = await openCodexToolProbe({ model: 'gpt-5.3-codex' }); await seed.turn(); sessionId = seed.driver.cliSessionId!;
        expect(sessionId).toBeTypeOf('string'); await seed.cleanup(true);
      }
      probe = await openCodexToolProbe({ model: 'gpt-5.3-codex',
        ...(resume ? { reuseHome: seed!.home, resumeSessionId: sessionId, replayHistory: false } : {}),
        prepareProject(cwd) {
          const nonce = basename(cwd); markers = { doc: 'PRISM_CONFIG_DOC_' + nonce, skill: 'PRISM_CONFIG_SKILL_' + nonce };
          writeFileSync(join(cwd, 'AGENTS.md'), markers.doc + '\n');
          const skill = join(cwd, '.agents/skills/config-fixture'); mkdirSync(skill, { recursive: true });
          writeFileSync(join(skill, 'SKILL.md'), '---\nname: config-fixture\ndescription: ' + markers.skill + '\n---\nOwned inert skill fixture.\n');
        },
        config: cwd => ({ ...(!scenario.docs ? { project_doc_max_bytes: 0 } : {}), ...(scenario.allSkills ? { 'skills.include_instructions': false } : !scenario.skills ? { 'skills.config': [{ path: join(cwd, '.agents/skills/config-fixture/SKILL.md'), enabled: false }] } : {}) }),
      });
      await probe.turn(); expect(probe.requests).toHaveLength(1);
      const wire = JSON.stringify(probe.requests[0]); expect(wire.includes(markers!.doc)).toBe(scenario.docs); expect(wire.includes(markers!.skill)).toBe(scenario.skills);
      const method = resume ? 'thread/resume' : 'thread/start', rpc = probe.sent.find(row => row.method === method);
      expect(rpc).toBeDefined(); if (resume) expect(probe.driver.cliSessionId).toBe(sessionId);
      const initialized = probe.received.find(row => typeof row.result?.userAgent === 'string'); expect(initialized?.result.userAgent).toMatch(/\/0\.163\.0(?:\s|$)/);
      console.info(JSON.stringify({ codexConfigProof: true, platform: process.platform, method, scenario: scenario.name, docOffered: wire.includes(markers!.doc), skillOffered: wire.includes(markers!.skill), resumeIdentityPreserved: resume ? probe.driver.cliSessionId === sessionId : null, actualRequests: probe.requests.length, realAuthenticationOrModelCall: false }));
    } finally { if (probe) await probe.cleanup(); if (seed) await seed.cleanup(); }
  }, 60000);
  for (const mode of ['default', 'per-file list', 'instructions disabled'] as const) it(`new skill after the first turn: ${mode}`, async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex',
      config: cwd => mode === 'instructions disabled' ? { 'skills.include_instructions': false } : mode === 'per-file list' ? { 'skills.config': [{ path: join(cwd, '.agents/skills/known/SKILL.md'), enabled: false }] } : {},
    });
    try {
      await probe.turn(); const marker = 'PRISM_NEW_SKILL_' + basename(probe.cwd), directory = join(probe.cwd, '.agents/skills/new-skill'); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'SKILL.md'), '---\nname: new-skill\ndescription: ' + marker + '\n---\nOwned new inert skill fixture.\n');
      await probe.turn(); expect(probe.requests).toHaveLength(2);
      expect(JSON.stringify(probe.requests[0])).not.toContain(marker);
      const offered = JSON.stringify(probe.requests[1]).includes(marker); expect(offered).toBe(mode !== 'instructions disabled');
      console.info(JSON.stringify({ codexConfigMidSessionProof: true, platform: process.platform, mode, skillOffered: offered, actualRequests: probe.requests.length, realAuthenticationOrModelCall: false }));
    } finally { await probe.cleanup(); }
  }, 60000);
  it('per-file skill config and project-doc config preserve the restricted native tool surface', async () => {
    const probe = await openCodexToolProbe({ model: 'gpt-5.3-codex', nativeTools: 'none', config: { project_doc_max_bytes: 0, 'skills.config': [], 'skills.include_instructions': false } });
    try {
      await probe.turn(); expect(advertisedTools(probe.requests[0])).toEqual([...CODEX_NATIVE_TOOLS_NONE.residualTools, 'mcp__owned.app_ping'].sort());
      const rpc = probe.sent.find(row => row.method === 'thread/start'); expect(rpc?.params.config.skills.config).toEqual([]); expect(rpc?.params.config.skills.include_instructions).toBe(false);
    } finally { await probe.cleanup(); }
  }, 60000);
});
