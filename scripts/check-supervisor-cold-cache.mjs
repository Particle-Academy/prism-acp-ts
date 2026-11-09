// The baseline is immutable released code with the measured mixed-generation bug. Execute it, never fake its result.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coldBaselineConfig, coldHashFailureKind } from './supervisor-cold-evidence.mjs';

if(process.platform!=='win32')throw Error('The Windows cold-cache gate must run on Windows');
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const baseline='8200070239c343e06cabe868f5e33a0ae32f94b5'; // Published 0.31.0; identical old cache producer to held cf1077b.
const lastCompilerPublisher='ba70175a8cd44cc03ee165640458e6210f14c251'; // Immutable published 0.40.0; 0.41 never compiles at runtime.
const source=join(root,'src','process-tree.ts');
const original=readFileSync(source);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalHash=hash(original);
const supervisorSource=join(root,'src','process-tree-supervisor-cs.ts');
const originalSupervisorHash=hash(readFileSync(supervisorSource));
const logs=join(root,'.cold-cache-evidence');mkdirSync(logs,{recursive:true});
function run(binary,args,settings={}){
 const result=spawnSync(binary,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,timeout:540000,...settings});
 if(result.error)throw result.error;
 return result;
}
function build(config=join(root,'tsconfig.json'),label='current-build'){
 const result=run(process.execPath,[join(root,'node_modules','typescript','bin','tsc'),'-p',config]);
 const output=(result.stdout??'')+(result.stderr??'');
 writeFileSync(join(logs,label+'.log'),JSON.stringify({exit:result.status})+'\n'+output);
 if(result.status!==0)throw Error('Cold-cache probe build failed: '+output.slice(0,2000));
}
function measure(label,moduleUrl){
 const result=run(process.execPath,[join(root,'node_modules','vitest','vitest.mjs'),'run','test/supervisor-cold-measure.test.ts'],
   {env:{...process.env,PRISM_ACP_SUPERVISOR_COLD:'1',PRISM_ACP_COLD_MODULE:moduleUrl}});
 writeFileSync(join(logs,label+'.log'),(result.stdout??'')+(result.stderr??''));
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 const clean=(result.stdout??'').replace(/\x1b\[[0-9;]*m/g,'');
 const summaries=clean.split(/\r?\n/).filter(line=>line.startsWith('{"supervisorColdSummary":'));
 if(summaries.length!==1)throw Error(label+': expected exactly one complete measurement summary');
 const summary=JSON.parse(summaries[0]).supervisorColdSummary;
 if(summary.batches!==20||summary.parallelism!==8||summary.launches!==160||!Number.isInteger(summary.failed))throw Error(label+': incomplete measurement');
 const batches=clean.split(/\r?\n/).filter(line=>line.startsWith('{"supervisorColdBatch":')).map(line=>JSON.parse(line).supervisorColdBatch);
 if(batches.length!==20||batches.some((batch,i)=>batch.round!==i||batch.launches!==8))throw Error(label+': incomplete batch receipts');
 const hashEvidence=batches.flatMap(batch=>batch.failures).flatMap(failure=>{
  const kind=coldHashFailureKind(failure);
  return kind?[{kind,...(kind==='adapter-receipt'?{observedSha256:failure.observedSha256,recordedSha256:failure.recordedSha256}:{})}]:[];
 });
 const varianceValid=batches.every(batch=>Array.isArray(batch.workerCompiledDigests)&&batch.workerCompiledDigests.length===8&&batch.workerCompiledDigests.every(worker=>Array.isArray(worker)&&worker.every(value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)))&&new Set(batch.workerCompiledDigests.flat()).size>=2&&batch.compilerGenerations===new Set(batch.workerCompiledDigests.flat()).size);
 const scheduleValid=batches[0].scheduledPair?.verified===true;
 const scheduledHashRefusals=batches[0].failures.filter(failure=>failure.schedule?.role===0&&failure.schedule.events.includes('prepared-failed')&&!failure.schedule.events.includes('prepared-ok')&&coldHashFailureKind(failure)).length;
 return{exit:result.status,...summary,varianceValid,scheduleValid,scheduledHashRefusals,hashRefusals:hashEvidence.length,hashEvidence};
}
let oldSource=run('git',['show',baseline+':src/process-tree.ts']);
if(oldSource.status!==0){
 const fetched=run('git',['fetch','--no-tags','--depth=1','https://github.com/Particle-Academy/prism-acp-ts.git',baseline]);
 if(fetched.status!==0)throw Error('Cannot fetch immutable released baseline');
 oldSource=run('git',['show',baseline+':src/process-tree.ts']);
}
if(oldSource.status!==0||!oldSource.stdout.includes('function windowsSupervisor()'))throw Error('Immutable baseline source is missing');
const temporaryParent=realpathSync(tmpdir());
const owned=mkdtempSync(join(temporaryParent,'prism-cold-baseline-'));
const project=join(owned,'baseline');
const repairedProject=join(owned,'repaired-040');
let before,after,baselineError,currentError;
try{
 // Compile the immutable old publisher in its own package copy. The production
 // source is never swapped, stamped or instrumented, including during baseline.
 cpSync(join(root,'src'),join(project,'src'),{recursive:true});
 writeFileSync(join(project,'src','process-tree.ts'),oldSource.stdout);
 writeFileSync(join(project,'package.json'),'{"type":"module"}\n');
 const baselineConfig=join(project,'tsconfig.json');
 writeFileSync(baselineConfig,JSON.stringify(coldBaselineConfig(project,root),null,2)+'\n');
 build(baselineConfig,'baseline-build');
 let repairedSource=run('git',['show',lastCompilerPublisher+':src/process-tree.ts']);
 if(repairedSource.status!==0){
  const fetched=run('git',['fetch','--no-tags','--depth=1','https://github.com/Particle-Academy/prism-acp-ts.git',lastCompilerPublisher]);
  if(fetched.status!==0)throw Error('Cannot fetch immutable released 0.40 publisher');
  repairedSource=run('git',['show',lastCompilerPublisher+':src/process-tree.ts']);
 }
 if(repairedSource.status!==0||!repairedSource.stdout.includes('function windowsSupervisor()'))throw Error('Immutable released 0.40 publisher is missing');
 cpSync(join(root,'src'),join(repairedProject,'src'),{recursive:true});
 writeFileSync(join(repairedProject,'src','process-tree.ts'),repairedSource.stdout);
 writeFileSync(join(repairedProject,'package.json'),'{"type":"module"}\n');
 const repairedConfig=join(repairedProject,'tsconfig.json');
 writeFileSync(repairedConfig,JSON.stringify(coldBaselineConfig(repairedProject,root),null,2)+'\n');
 build(repairedConfig,'repaired-040-build');
 build();
 try{before=measure('baseline',pathToFileURL(join(project,'dist','process-tree.js')).href);}catch(error){baselineError=error.message;}
 try{after=measure('repaired-040',pathToFileURL(join(repairedProject,'dist','process-tree.js')).href);}catch(error){currentError=error.message;}
 const productionUnchanged=hash(readFileSync(source))===originalHash&&hash(readFileSync(supervisorSource))===originalSupervisorHash;
 writeFileSync(join(logs,'summary.json'),JSON.stringify({baselineRef:baseline,repairedRef:lastCompilerPublisher,repairedSourceSha256:hash(Buffer.from(repairedSource.stdout)),baselineSourceSha256:hash(Buffer.from(oldSource.stdout)),currentSourceSha256:originalHash,supervisorSourceSha256:originalSupervisorHash,restored:productionUnchanged,productionUnchanged,before,after,baselineError,currentError,historicalOnly:true,shippedSupervisorProof:false},null,2)+'\n');
 if(!productionUnchanged)throw Error('Production publisher or supervisor source changed during the cold oracle');
 if(baselineError||!before||!before.varianceValid||!before.scheduleValid||before.scheduledHashRefusals!==1||before.exit!==1||before.failed<1||before.hashRefusals<1)throw Error('The old producer did not reproduce a proven hash refusal under valid compiler variance and the native publication schedule');
 if(currentError||!after||!after.varianceValid||!after.scheduleValid||after.exit!==0||after.failed!==0||after.approvalVerified!==160)throw Error('Current producer failed the cold-cache/approval oracle, publication schedule or compiler-variance precondition');
 console.log('Historical Windows cache regression verified: 0.31 '+before.failed+'/160 refusals; immutable 0.40 0/160; 160 approval adapters verified. Not a 0.41 shipped-supervisor proof.');
}finally{
 const unchanged=hash(readFileSync(source))===originalHash&&hash(readFileSync(supervisorSource))===originalSupervisorHash;
 if(dirname(realpathSync(owned))!==temporaryParent)throw Error('Owned baseline cleanup escaped temporary parent');
 rmSync(owned,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 if(!unchanged)throw Error('Production source hash changed during the cold-cache gate');
}
