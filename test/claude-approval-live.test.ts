import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareProcessTree } from '../src/process-tree.js';
import { buildFakeElectron, buildParentProbe, buildSilentZeroAdapter } from './fixtures/fake-electron.js';
import { assertApprovalResult, DENY_REASON, probeClaudeApproval, type ApprovalScenario } from './fixtures/claude-approval-probe.js';

// Opt-in, pinned native CLI, loopback-only model, empty profiles, fake key. A missing/version-mismatched CLI fails.
describe.runIf(process.env.PRISM_ACP_CLAUDE_APPROVAL === '1')('native Claude2.1.310 approval enforcement', () => {
  let root: string, electron: string;
  let silentZeroAdapter: string|undefined;
  let parentProbe: string|undefined;
  const binary = process.env.PRISM_ACP_CLAUDE_BINARY ?? '';
  beforeAll(async()=>{
    if(!binary)throw new Error('Set PRISM_ACP_CLAUDE_BINARY to the installed native Claude2.1.310 executable');
    await prepareProcessTree();
    root=mkdtempSync(join(tmpdir(),'prism-electron-native-'));
    const path=join(root,"space ' & % é $ `");mkdirSync(path);
    electron=buildFakeElectron(path);
    silentZeroAdapter=buildSilentZeroAdapter(path);
    parentProbe=buildParentProbe(path);
  },60000);
  afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});});

  it('allows once, uses the actual driver-built command, and leaves provider/grandchild env clean', async()=>{
    const r=await probeClaudeApproval({binary,electron,parentProbe,scenario:'allow',captureLauncher:true});
    assertApprovalResult(r,true);
    expect(r.launcher.flag).toBe(null);
    console.info(JSON.stringify({nativeApproval:'allow',launcher:r.launcher,providerFlag:r.providerFlag,cleanGrandchild:r.cleanGrandchild}).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
  },60000);

  it('a trusted explicit Node override works inside an Electron host',async()=>{
    assertApprovalResult(await probeClaudeApproval({binary,electron,scenario:'allow',nodeOverride:true}),true);
  },60000);

  it('MEASUREMENT: records the actual legacy shell-form launcher on this platform',async()=>{
    const r=await probeClaudeApproval({binary,electron,parentProbe,scenario:'allow',nodeOverride:true,captureLauncher:true,legacyShell:true});
    assertApprovalResult(r,true);
    console.info(JSON.stringify({nativeApprovalLegacyShell:r.launcher}).replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));
  },60000);

  for(const scenario of ['deny','cancel','callback-crash','channel-hang','runtime-empty','runtime-crash','runtime-hang','runtime-invalid','runtime-allow-zero','runtime-allow-two','worker-empty','worker-crash','worker-extra','worker-invalid','worker-signal'] satisfies ApprovalScenario[]) {
    it(`${scenario}: no Bash command runs`,async()=>{
      const r=await probeClaudeApproval({binary,electron,scenario});
      assertApprovalResult(r,false);
      if(scenario==='deny')expect(JSON.stringify(r.toolResults)).toContain(DENY_REASON);
      if(scenario==='runtime-hang')expect(JSON.stringify(r.toolResults)).toMatch(/timed out/i);
      if(['runtime-empty','runtime-crash','runtime-invalid'].includes(scenario))expect(JSON.stringify(r.toolResults)).toContain('prism-acp: approval hook failed or denied; tool call blocked');
      console.info(JSON.stringify({nativeApproval:scenario,executed:r.executed,asked:r.asked,requests:r.requests}));
    },60000);
  }

  for(const control of [{stderr:true,onFailure:'block'},{stderr:false,onFailure:'block'},{stderr:false,onFailure:'continue'}] as const){
    it(`G139 precedence: direct allow JSON + exit2 denies (stderr=${control.stderr},onFailure=${control.onFailure})`,async()=>{
      const r=await probeClaudeApproval({binary,electron,scenario:'allow',directHookExit:2,directHookStderr:control.stderr,directHookOnFailure:control.onFailure});
      assertApprovalResult(r,false);expect(r.asked).toBe(0);
      if(control.stderr)expect(JSON.stringify(r.toolResults)).toContain('OWN_DIRECT_BLOCK');
      console.info(JSON.stringify({allowStdoutExitTwo:{direct:true,stderr:control.stderr,onFailure:control.onFailure,executed:r.executed,toolError:r.toolResults.some((v:Record<string,unknown>)=>v.is_error===true)}}));
    },60000);
  }
  it('G139 precedence CONTROL: the same direct allow JSON + exit0 runs the tool',async()=>{
    const r=await probeClaudeApproval({binary,electron,scenario:'allow',directHookExit:0});
    expect(r.nativeCode).toBe(0);expect(r.requests).toBe(2);expect(r.executed).toBe(true);expect(r.asked).toBe(0);
    console.info(JSON.stringify({allowStdoutExitZeroControl:true,executed:r.executed}));
  },60000);

  for(const mutation of ['drop-wrapper','allow-silent-zero','leak-electron'] as const){
    it(`MUTATION CONTROL: ${mutation} makes the same safety oracle fail`,async()=>{
      const allow=mutation==='leak-electron';
      const r=await probeClaudeApproval({binary,electron,silentZeroAdapter,scenario:allow?'allow':'runtime-empty',mutation});
      expect(()=>assertApprovalResult(r,allow)).toThrow();
      expect(r.executed).toBe(!allow);
      console.info(JSON.stringify({nativeApprovalMutation:mutation,oracle:'rejected',executed:r.executed}));
    },60000);
  }

  for(const versionFault of ['missing','old','malformed','error','timeout'] as const){
    it(`version gate ${versionFault}: refuses before the first prompt or model request`,async()=>{
      const r=await probeClaudeApproval({binary,electron,scenario:'allow',versionFault});
      expect(r.reportedVersions[0]).toEqual({source:'control.initialize',version:'2.1.310'});
      expect(r.requests).toBe(0);expect(r.sentUsers).toBe(0);expect(r.asked).toBe(0);expect(r.executed).toBe(false);
      expect(r.errors.join(' ')).toMatch(/permission prompts/);
      console.info(JSON.stringify({nativeApprovalVersion:versionFault,refused:true,sentUsers:r.sentUsers,requests:r.requests}));
    },60000);
  }
  for(const versionFault of ['init-missing','init-changed'] as const){
    it(`${versionFault}: a later system/init omission/change closes the real session`,async()=>{
      const r=await probeClaudeApproval({binary,electron,scenario:'allow',versionFault});
      expect(r.executed).toBe(false);expect(r.asked).toBe(0);expect(r.errors.join(' ')).toMatch(/system\/init omitted or changed/);
    },60000);
  }
});
