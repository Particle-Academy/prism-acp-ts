// Native test bridge only: injects the loopback endpoint and protocol/command faults inside an owned process tree.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(process.env.ANTHROPIC_API_KEY!=='prism-fake-not-a-real-key'||new URL(config.modelUrl).hostname!=='127.0.0.1')throw new Error('native probe requires owned loopback model and fake key');
const args=process.argv.slice(3);
const settingsPath=args[args.indexOf('--settings')+1];
const settings=JSON.parse(readFileSync(settingsPath,'utf8'));
const hook=settings.hooks.PreToolUse[0].hooks[0];
const scriptPath=join(dirname(settingsPath),'approve.cjs');
let script=readFileSync(scriptPath,'utf8');
const faults={
 'worker-empty':'process.exit(0);', 'worker-crash':'throw new Error("owned crash");',
 'worker-extra':'process.stdout.write("extra");','worker-invalid':'process.stdout.write("{invalid-json");',
 'worker-signal':'process.kill(process.pid,"SIGTERM");',
};
if(faults[config.scenario])script=script.replace("const http = require('http');",`${faults[config.scenario]} const http = require('http');`);
if(config.mutation==='leak-electron')script=script.replace('delete process.env.ELECTRON_RUN_AS_NODE;','// deliberate mutation: leaked Electron flag');
script=script.replace("const http = require('http');",`const check=require('child_process').spawnSync(${JSON.stringify(process.execPath)},['-p','String(process.env.ELECTRON_RUN_AS_NODE)'],{encoding:'utf8'});if(check.stdout.trim()!=='undefined')process.exit(7); const http = require('http');`);
if(config.captureLauncher){
 const inspect=process.platform==='win32'
  ? `require('child_process').execFileSync(${JSON.stringify(config.parentProbe)},[String(process.ppid)],{encoding:'utf8',windowsHide:true}).trim().split(/\\r?\\n/).filter(Boolean).map(s=>Buffer.from(s,'base64').toString('utf8'))`
  : `require('fs').readlinkSync('/proc/'+process.ppid+'/exe')`;
 script=script.replace("const http = require('http');",`require('fs').writeFileSync(${JSON.stringify(config.launcher)},JSON.stringify({parent:${inspect},runtime:process.execPath,flag:process.env.ELECTRON_RUN_AS_NODE??null})); const http = require('http');`);
}
if(config.legacyShell){
 hook.command=`"${process.execPath.replaceAll('\\','/')}" "${scriptPath.replaceAll('\\','/')}"`;delete hook.args;
 script=script.replace('process.exit(allow ? 42 : 2);','process.exit(allow ? 0 : 2);');
}
writeFileSync(scriptPath,script);
if(config.directHookExit!==undefined){
 const output=JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:'Synthetic direct approval.'}})+'\n';
 hook.command=process.execPath;
 hook.args=['-e',`process.stdout.write(${JSON.stringify(output)},()=>{${config.directHookStderr?"process.stderr.write('OWN_DIRECT_BLOCK\\n');":''}process.exit(${config.directHookExit});});`];
 hook.onFailure=config.directHookOnFailure??'block';
}
if(config.scenario==='runtime-hang')hook.timeout=1;
if(config.mutation==='drop-wrapper'){hook.command=config.electron;hook.args=[scriptPath];}
if(config.mutation==='allow-silent-zero'){
 if(process.platform==='win32'){
  if(!config.silentZeroAdapter)throw new Error('native Windows mutation adapter missing');
  hook.command=config.silentZeroAdapter;
 }
 else hook.args[1]=hook.args[1].replace('"$code" -eq 42','"$code" -eq 0');
}
writeFileSync(settingsPath,JSON.stringify(settings));
const receipt={providerFlag:process.env.ELECTRON_RUN_AS_NODE??null,sent:[],versions:[],nativeCode:null};
const save=()=>writeFileSync(config.receipt,JSON.stringify(receipt));save();
const mode=config.scenario.startsWith('runtime-')?config.scenario.slice('runtime-'.length):undefined;
const env={...process.env,ANTHROPIC_BASE_URL:config.modelUrl,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_USE_POWERSHELL_TOOL:'0',HTTP_PROXY:config.proxyUrl,HTTPS_PROXY:config.proxyUrl,NO_PROXY:'127.0.0.1,localhost',...(mode?{PRISM_FAKE_ELECTRON_MODE:mode}:{})};
const native=spawn(config.binary,[...args,'--setting-sources','','--max-turns','2'],{cwd:process.cwd(),env,stdio:['pipe','pipe','pipe'],windowsHide:true});
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);receipt.sent.push({type:frame.type,subtype:frame.request?.subtype});save();native.stdin.write(line+'\n');
}).on('close',()=>native.stdin.end());
native.stdin.on('error',()=>{});native.stderr.pipe(process.stderr);
createInterface({input:native.stdout}).on('line',line=>{
 const frame=JSON.parse(line);
 const initialize=frame.type==='control_response'&&frame.response?.response?.claude_code_version!==undefined;
 const init=frame.type==='system'&&frame.subtype==='init';
 if(initialize||init){receipt.versions.push({source:initialize?'control.initialize':'system/init',version:initialize?frame.response.response.claude_code_version:frame.claude_code_version});save();}
 if(initialize&&config.versionFault==='timeout')return;
 if(initialize&&config.versionFault==='error'){frame.response={...frame.response,subtype:'error',error:'owned initialize failure'};delete frame.response.response;}
 if(initialize&&['missing','old','malformed'].includes(config.versionFault)){
  if(config.versionFault==='missing')delete frame.response.response.claude_code_version;
  else frame.response.response.claude_code_version=config.versionFault==='old'?'2.1.294':'unparseable';
 }
 if(init&&config.versionFault==='init-missing')delete frame.claude_code_version;
 if(init&&config.versionFault==='init-changed')frame.claude_code_version='2.1.309';
 process.stdout.write(JSON.stringify(frame)+'\n');
});
native.on('error',()=>process.exit(1));
native.on('close',code=>{receipt.nativeCode=code;save();process.exit(code??1);});
