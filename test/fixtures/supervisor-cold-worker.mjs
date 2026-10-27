import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { compiledDigests, compilerAttempts, configureColdSchedule, finishColdPreparation, scheduleEvents } from './supervisor-compiler-observer.mjs';
const [moduleUrl,cache,go,ready,cwd,coordination,role]=process.argv.slice(2);
configureColdSchedule(coordination,cache,role);
const {prepareProcessTree,launchProvider,windowsApprovalAdapter}=await import(moduleUrl);
if([prepareProcessTree,launchProvider,windowsApprovalAdapter].some(value=>typeof value!=='function'))throw Error('cold worker API import is incomplete');
writeFileSync(ready,'ready');
while(!existsSync(go))await new Promise(r=>setTimeout(r,5));
let provider;
try{
 let prepared=false;
 try{await prepareProcessTree({directory:cache});prepared=true;}
 finally{finishColdPreparation(prepared);}
 const adapter=windowsApprovalAdapter();
 const digest=createHash('sha256').update(readFileSync(adapter)).digest('hex');
 const namedDigest=/prism-acp-supervisor-([0-9a-f]{64})\.exe$/.exec(adapter)?.[1];
 const recorded=namedDigest??readFileSync(adapter+'.sha256','utf8').trim();
 if(digest!==recorded)throw Object.assign(Error('adapter hash did not match its complete cache receipt'),{
  code:'adapter_receipt_hash_mismatch',observedSha256:digest,recordedSha256:recorded,
 });
 const allow=join(cwd,'approval-allow-'+process.pid+'.cjs'),deny=join(cwd,'approval-deny-'+process.pid+'.cjs');
 writeFileSync(allow,`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));process.exit(42);`);
 writeFileSync(deny,'process.exit(0);');
 const allowed=spawnSync(adapter,['approval',process.execPath,allow,'node'],{input:'{}',encoding:'utf8',timeout:5000,windowsHide:true});
 const denied=spawnSync(adapter,['approval',process.execPath,deny,'node'],{input:'{}',encoding:'utf8',timeout:5000,windowsHide:true});
 if(allowed.status!==0||denied.status!==2)throw Error('native approval adapter did not preserve allow42/deny0 outcomes');
 provider=launchProvider(process.execPath,['-e',"process.stdout.write('OWN_READY\\n');setInterval(()=>{},1000)"],{cwd,env:process.env});
 provider.child.stdout?.resume();provider.child.stderr?.resume();
 await provider.started;
 await new Promise(r=>setTimeout(r,200));
 const stop=await provider.stop({graceMs:0});
 if(!stop.verified||!stop.empty||stop.survivors!==0)throw Error('inner provider tree was not verified empty');
 console.log(JSON.stringify({coldWorker:true,success:true,approval:{allowExit:allowed.status,denyExit:denied.status,hashVerified:true},compiledDigests,compilerAttempts,generationDigest:digest,stop,schedule:coordination?{role:Number(role),events:scheduleEvents}:null}));
}catch(cause){console.log(JSON.stringify({coldWorker:true,success:false,name:cause?.name,message:cause?.message,
 code:cause?.code,observedSha256:cause?.observedSha256,recordedSha256:cause?.recordedSha256,compiledDigests,compilerAttempts,schedule:coordination?{role:Number(role),events:scheduleEvents}:null}));process.exitCode=1;}
finally{if(provider)await provider.stop({graceMs:0});}
