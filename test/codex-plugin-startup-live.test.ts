import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openCodexToolProbe } from './fixtures/codex-native-tools-probe.js';

type Probe=Awaited<ReturnType<typeof openCodexToolProbe>>;
function assertNoPlugins(home:string){
  const pending=[home];let entries=0;
  while(pending.length){const current=pending.pop()!;for(const entry of readdirSync(current,{withFileTypes:true})){
    expect(++entries).toBeLessThanOrEqual(4096);
    expect(entry.name).not.toMatch(/^plugins(?:-|$)/);
    if(entry.isDirectory())pending.push(join(current,entry.name));
  }}
}
function assertStartup(probe:Probe){
  expect(probe.problems).toEqual([]);
  expect(probe.startupConfig()?.features).toMatchObject({plugins:false,remote_plugin:false,mentions_v2:true});
  expect(probe.blockedConnections).toEqual([]);
  assertNoPlugins(probe.home);
}
describe.runIf(process.env.PRISM_ACP_CODEX_NATIVE_TOOLS==='1')('native Codex0.163.0 plugin startup restriction',()=>{
  it('holds a restricted profile for10s without plugin trees or acquisition, then invokes only the supplied MCP tool',async()=>{
    const probe=await openCodexToolProbe({model:'gpt-5.3-codex',nativeTools:'none',
      inheritedFeatures:{plugins:true,remote_plugin:true,mentions_v2:true},
      calls:[{type:'function_call',namespace:'mcp__owned',name:'app_ping',arguments:'{}'}]});
    try{
      assertStartup(probe);
      const until=Date.now()+10000;
      do{await new Promise(r=>setTimeout(r,200));assertStartup(probe);}while(Date.now()<until);
      await probe.turn();expect(probe.outputs()).toContain('PRISM_TOOL_owned');assertStartup(probe);
      console.info(JSON.stringify({pluginStartupRestriction:true,waitMs:10000,noPluginTree:true,auxiliaryAttempts:0,
        startupFeatures:probe.startupConfig()?.features,unrelatedFeatureRetained:true,suppliedMcpSucceeded:true}));
    }finally{await probe.cleanup();}
  },40000);

  it('ordinary CONTROL keeps plugin startup enabled and detects native source attempts at the rejecting proxy',async()=>{
    const probe=await openCodexToolProbe({model:'gpt-5.3-codex',inheritedFeatures:{plugins:true,remote_plugin:true,mentions_v2:true}});
    try{
      const until=Date.now()+10000;
      while(!probe.blockedConnections.includes('github.com:443')&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
      expect(probe.blockedConnections).toContain('github.com:443');
      expect(probe.requests).toHaveLength(0);
      console.info(JSON.stringify({pluginStartupOrdinaryControl:true,pluginSourceAttempt:true,forwarded:false}));
    }finally{await probe.cleanup();}
  },30000);

  it('MUTATION CONTROL: removing launch overrides fails the same startup oracle and refuses before a thread',async()=>{
    const probe=await openCodexToolProbe({model:'gpt-5.3-codex',nativeTools:'none',removeStartupPluginArgs:true,inheritedFeatures:{mentions_v2:true}});
    try{
      expect(()=>assertStartup(probe)).toThrow();
      expect(probe.problems.join(' ')).toContain('could not verify startup feature plugins=false');
      expect(probe.sent.some(f=>f.method==='thread/start'||f.method==='turn/start')).toBe(false);
      expect(probe.requests).toHaveLength(0);
      console.info(JSON.stringify({pluginStartupMutationCaught:true,threadStarted:false,modelRequests:0}));
    }finally{await probe.cleanup();}
  },30000);
});
