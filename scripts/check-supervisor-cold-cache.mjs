// The baseline is immutable released code with the measured mixed-generation bug. Execute it, never fake its result.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if(process.platform!=='win32')throw Error('The Windows cold-cache gate must run on Windows');
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const baseline='8200070239c343e06cabe868f5e33a0ae32f94b5'; // Published 0.31.0; identical old cache producer to held cf1077b.
const source=join(root,'src','process-tree.ts');
const original=readFileSync(source);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalHash=hash(original);
const logs=join(root,'.cold-cache-evidence');mkdirSync(logs,{recursive:true});
function run(binary,args,settings={}){
 const result=spawnSync(binary,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,timeout:540000,...settings});
 if(result.error)throw result.error;
 return result;
}
function build(){
 const result=run(process.execPath,[join(root,'node_modules','typescript','bin','tsc'),'-p','tsconfig.json']);
 if(result.status!==0)throw Error('Cold-cache probe build failed: '+result.stderr.slice(0,1000));
}
function measure(label){
 const result=run(process.execPath,[join(root,'node_modules','vitest','vitest.mjs'),'run','test/supervisor-cold-measure.test.ts'],
   {env:{...process.env,PRISM_ACP_SUPERVISOR_COLD:'1'}});
 writeFileSync(join(logs,label+'.log'),(result.stdout??'')+(result.stderr??''));
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 const clean=(result.stdout??'').replace(/\x1b\[[0-9;]*m/g,'');
 const summaries=clean.split(/\r?\n/).filter(line=>line.startsWith('{"supervisorColdSummary":'));
 if(summaries.length!==1)throw Error(label+': expected exactly one complete measurement summary');
 const summary=JSON.parse(summaries[0]).supervisorColdSummary;
 if(summary.batches!==20||summary.parallelism!==8||summary.launches!==160||!Number.isInteger(summary.failed))throw Error(label+': incomplete measurement');
 const batches=clean.split(/\r?\n/).filter(line=>line.startsWith('{"supervisorColdBatch":')).map(line=>JSON.parse(line).supervisorColdBatch);
 if(batches.length!==20||batches.some((batch,i)=>batch.round!==i||batch.launches!==8))throw Error(label+': incomplete batch receipts');
 const hashRefusals=batches.flatMap(batch=>batch.failures).filter(failure=>failure.name==='ProcessTreeError'&&/supervisor does not match the hash recorded when it was built/.test(failure.message)).length;
 return{exit:result.status,...summary,hashRefusals};
}
let oldSource=run('git',['show',baseline+':src/process-tree.ts']);
if(oldSource.status!==0){
 const fetched=run('git',['fetch','--no-tags','--depth=1','https://github.com/Particle-Academy/prism-acp-ts.git',baseline]);
 if(fetched.status!==0)throw Error('Cannot fetch immutable released baseline');
 oldSource=run('git',['show',baseline+':src/process-tree.ts']);
}
if(oldSource.status!==0||!oldSource.stdout.includes('function windowsSupervisor()'))throw Error('Immutable baseline source is missing');
let before;
try{
 writeFileSync(source,oldSource.stdout);build();before=measure('baseline');
 if(before.exit!==1||before.failed<1||before.hashRefusals<1)throw Error('The old producer did not reproduce a hash refusal in the same cold-cache oracle');
}finally{
 writeFileSync(source,original);
 if(hash(readFileSync(source))!==originalHash)throw Error('Current source restoration hash mismatch');
 build();
}
const after=measure('current');
if(after.exit!==0||after.failed!==0||after.approvalVerified!==160)throw Error('Current producer failed the cold-cache/approval oracle');
writeFileSync(join(logs,'summary.json'),JSON.stringify({baselineRef:baseline,currentSourceSha256:originalHash,restored:true,before,after},null,2)+'\n');
console.log('Windows cold-cache regression verified: baseline '+before.failed+'/160 refusals; current 0/160; 160 approval adapters verified.');
