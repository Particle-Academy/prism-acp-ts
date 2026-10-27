import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchProvider, prepareProcessTree, type ProviderProcess } from '../src/process-tree.js';
import { digest, ownedProducer } from '../scripts/supervisor-cold-owned.mjs';

const rootModule=process.env.PRISM_ACP_COLD_MODULE??new URL('../dist/process-tree.js',import.meta.url).href;
const worker=fileURLToPath(new URL('./fixtures/supervisor-cold-worker.mjs',import.meta.url));
async function until(read:()=>boolean,ms:number){const deadline=Date.now()+ms;while(!read()){if(Date.now()>deadline)throw Error('owned cold worker barrier timeout');await new Promise(r=>setTimeout(r,10));}}
describe.runIf(process.platform==='win32'&&process.env.PRISM_ACP_SUPERVISOR_COLD==='1')('cross-process empty supervisor cache',()=>{
 it('measures20 cold batches of8 parallel first launches without retrying failures',async()=>{
  const parent=realpathSync(tmpdir());const root=mkdtempSync(join(parent,'prism-supervisor-cold-'));
  const productionPublisher=readFileSync(fileURLToPath(rootModule));
  const productionSupervisor=readFileSync(new URL('./process-tree-supervisor-cs.js',rootModule));
  const rows:Record<string,unknown>[]=[];
  try{
   await prepareProcessTree({directory:join(root,'host-cache')}); // The outer harness has its own separate cache.
   for(let round=0;round<20;round++){
    const dir=join(root,'round-'+round);mkdirSync(dir);const cache=join(dir,'cache');const go=join(dir,'go');
    const coordination=round===0?join(dir,'coordination'):'';if(coordination)mkdirSync(coordination);
    const providers:ProviderProcess[]=[],outputs:string[]=[],closed:Promise<unknown>[]=[];
    try{
     for(let i=0;i<8;i++){
      outputs[i]='';const ready=join(dir,'ready-'+i);
      const producer=ownedProducer(rootModule,join(dir,'producer-'+i),round+'-'+i);
      expect(producer.publisherSha256).toBe(digest(productionPublisher));
      expect(producer.originalSupervisorSha256).toBe(digest(productionSupervisor));
      const provider=launchProvider(process.execPath,[worker,producer.moduleUrl,cache,go,ready,dir,coordination,String(i)],{cwd:dir,env:process.env});providers.push(provider);
      provider.child.stdout?.on('data',chunk=>{outputs[i]+=chunk.toString();});provider.child.stderr?.resume();
      closed.push(new Promise(resolve=>provider.child.once('close',resolve)));
     }
     await Promise.all(providers.map(provider=>provider.started));
     await until(()=>providers.every((_,i)=>existsSync(join(dir,'ready-'+i))),10000);
     writeFileSync(go,'go');
     let timer:ReturnType<typeof setTimeout>|undefined;
     let codes:unknown[];
     try{codes=await Promise.race([Promise.all(closed),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('owned cold workers deadline')),60000);})]);}
     finally{clearTimeout(timer);}
     const result=outputs.map((output,i)=>{try{const receipt=JSON.parse(output.trim());
       if(receipt.success===true&&(codes[i]!==0||!receipt.stop?.verified||!receipt.stop?.empty||receipt.stop?.survivors!==0))return{success:false,message:'worker exit/stop receipt was invalid',receipt,code:codes[i]};
       return receipt;
      }catch{return{success:false,message:'worker did not return one JSON receipt',output:output.slice(0,1000)};}});
     const failures=result.filter(receipt=>receipt.success!==true);
     const workerCompiledDigests=result.map(receipt=>{
      if(!Array.isArray(receipt.compiledDigests)||receipt.compiledDigests.some((value:unknown)=>typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value)))throw Error('invalid actual compiler digest receipt');
      return receipt.compiledDigests as string[];
     });
     const compilerGenerations=new Set(workerCompiledDigests.flat()).size;
     const approvalVerified=result.filter(receipt=>receipt.approval?.allowExit===0&&receipt.approval?.denyExit===2&&receipt.approval?.hashVerified===true).length;
     const scheduledPair=round===0?{
      verified:result[0].schedule?.role===0&&result[1].schedule?.role===1
       &&['compiled','published','observed-peer-prepared'].every(event=>result[0].schedule?.events.includes(event))
       &&result[1].schedule?.events.includes('prepared-ok')
       &&workerCompiledDigests[0].length>0&&workerCompiledDigests[1].length>0&&workerCompiledDigests[0][0]!==workerCompiledDigests[1][0],
      first:result[0].schedule,second:result[1].schedule,
     }:null;
     rows.push({round,launches:8,failed:failures.length,approvalVerified,workerCompiledDigests,compilerGenerations,failures,scheduledPair});
     console.info(JSON.stringify({supervisorColdBatch:rows.at(-1)}));
    }finally{
     const stops=await Promise.all(providers.map(provider=>provider.stop({graceMs:0})));
     expect(stops.every(stop=>stop.verified&&stop.empty&&stop.survivors===0)).toBe(true);
    }
   }
   const failed=rows.reduce((sum,row)=>sum+Number(row.failed),0);
   const approvalVerified=rows.reduce((sum,row)=>sum+Number(row.approvalVerified),0);
   const minCompilerGenerations=Math.min(...rows.map(row=>Number(row.compilerGenerations)));
   console.info(JSON.stringify({supervisorColdSummary:{batches:rows.length,parallelism:8,launches:rows.length*8,failed,approvalVerified,
     cache:'empty task-owned directory each batch, shared across8 processes',compilerVariance:'owned inert assembly description per worker',minCompilerGenerations,osCachesPurged:false}}));
   expect(rows).toHaveLength(20);expect((rows[0].scheduledPair as {verified:boolean}).verified).toBe(true);expect(minCompilerGenerations).toBeGreaterThanOrEqual(2);expect(failed).toBe(0);expect(approvalVerified).toBe(160);
  }finally{
   const publisherUnchanged=digest(readFileSync(fileURLToPath(rootModule)))===digest(productionPublisher);
   const supervisorUnchanged=digest(readFileSync(new URL('./process-tree-supervisor-cs.js',rootModule)))===digest(productionSupervisor);
   if(dirname(realpathSync(root))!==parent)throw Error('Owned cold cache cleanup escaped temporary parent');
   rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
   expect(publisherUnchanged&&supervisorUnchanged).toBe(true);
  }
 },600000);
});
