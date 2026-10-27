import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { approvalHookScript, approvalSettings, ApprovalServer } from '../src/claude/approvals.js';
import { childEnv } from '../src/env.js';
import { launchProvider, prepareProcessTree } from '../src/process-tree.js';

// Product measurement: no timeout changes or retries. Fresh runner's first launch plus20 paired warm samples.
describe.runIf(process.env.PRISM_ACP_HOOK_LATENCY==='1')('approval adapter latency',()=>{
  it('measures direct-runtime and adapter roundtrips with an immediate approver',async()=>{
    await prepareProcessTree();
    const root=mkdtempSync(join(tmpdir(),'prism-hook-latency-'));
    const path=join(root,'approve.cjs');writeFileSync(path,approvalHookScript(5));
    const address=process.platform==='win32'?'\\\\.\\pipe\\prism-hook-latency-'+process.pid:join(root,'a.sock');
    const server=new ApprovalServer(address,async()=>({outcome:'selected',optionId:'allow_once'}));
    const channel=server.listen();
    const env={...childEnv(process.env).env,HOME:root,USERPROFILE:root,PRISM_ACP_APPROVAL_SOCKET:channel.socket,PRISM_ACP_APPROVAL_TOKEN:channel.token};
    const settings=approvalSettings(process.execPath,path,['Bash'],{timeoutSeconds:5}) as any;
    const hook=settings.hooks.PreToolUse[0].hooks[0];
    const input=JSON.stringify({tool_name:'Bash',tool_input:{command:'echo owned'},tool_use_id:'latency'});
    async function sample(wrapped:boolean){
      const start=performance.now();
      const provider=launchProvider(wrapped?hook.command:process.execPath,wrapped?hook.args:[path],{cwd:root,env});
      let stdout='';provider.child.stdout!.on('data',b=>stdout+=b);provider.child.stderr!.resume();
      const closed=new Promise<number|null>((resolve,reject)=>{provider.child.on('error',reject);provider.child.on('close',resolve);});
      try {
        await provider.started;provider.child.stdin!.end(input);
        const code=await closed;
        const ms=performance.now()-start;
        expect(code).toBe(wrapped?0:42);
        expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
        return ms;
      } finally {expect(await provider.stop({graceMs:0})).toMatchObject({verified:true,empty:true,survivors:0});}
    }
    const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {n:values.length,p50Ms:sorted[Math.ceil(values.length*.5)-1],p95Ms:sorted[Math.ceil(values.length*.95)-1],minMs:sorted[0],maxMs:sorted.at(-1)};};
    try {
      const firstAdapterMs=await sample(true),firstDirectMs=await sample(false);
      const direct:number[]=[],adapter:number[]=[],overhead:number[]=[];
      for(let i=0;i<20;i++){const baseline=await sample(false),wrapped=await sample(true);direct.push(baseline);adapter.push(wrapped);overhead.push(wrapped-baseline);}
      console.info(JSON.stringify({approvalAdapterLatency:{platform:process.platform,node:process.version,firstAdapterMs,firstDirectMs,coldDefinition:'first launch in this process/profile; OS caches not purged',direct:stats(direct),adapter:stats(adapter),pairedOverhead:stats(overhead),samples:{direct,adapter},stopReceipts:42,verifiedEmpty:true}}));
    } finally {server.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  },60000);
});
