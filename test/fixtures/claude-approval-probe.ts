import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeDriver } from '../../src/claude/driver.js';

type Row = Record<string, any>;
export type ApprovalScenario = 'allow' | 'deny' | 'cancel' | 'callback-crash' | 'channel-hang' | 'runtime-empty' | 'runtime-crash' | 'runtime-hang' | 'runtime-invalid' | 'worker-empty' | 'worker-crash' | 'worker-extra' | 'worker-invalid' | 'worker-signal';
export const ALLOW_REASON = "Allowed é ' & % $ ` \\ by owned probe";
export const DENY_REASON = 'The application refused: fixture shell limit é.';
export type ApprovalMutation = 'drop-wrapper' | 'allow-silent-zero' | 'leak-electron';
const realNode = process.execPath;

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function cleanParent(root: string): Record<string, string> {
  const allowed = new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','TMPDIR','LANG']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase()))) as Record<string,string>;
  return { ...env, HOME:root, USERPROFILE:root, XDG_CONFIG_HOME:root };
}

/** Native CLI is pinned; every request is answered locally. No real login, API key, account or model call. */
export async function probeClaudeApproval(options: { binary: string; electron: string; silentZeroAdapter?: string; parentProbe?: string; scenario: ApprovalScenario; mutation?: ApprovalMutation; nodeOverride?: boolean; captureLauncher?: boolean; legacyShell?: boolean; versionFault?: 'missing' | 'old' | 'malformed' | 'error' | 'timeout' | 'init-missing' | 'init-changed' }) {
  assert.match(execFileSync(options.binary, ['--version'], { encoding:'utf8', windowsHide:true }).trim(), /^2\.1\.310 \(Claude Code\)$/);
  const root = mkdtempSync(join(tmpdir(), 'prism-native-approval-'));
  const home = join(root, 'home'); mkdirSync(home);
  const requests: Row[] = [];
  const blockedConnections: string[] = [];
  const model = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!req.url?.includes('/messages')) { res.writeHead(404);res.end('{}');return; }
    const body = JSON.parse(raw); requests.push(body);
    assert(requests.length <= 3, 'probe exceeded finite request budget');
    const result = body.messages.some((m: Row) => Array.isArray(m.content) && m.content.some((c: Row) => c.type === 'tool_result'));
    const content = result ? [{type:'text',text:'Owned probe complete.'}] : [{type:'tool_use',id:'toolu_probe',name:'Bash',input:{command:`node -e "console.log('PRISM_HOOK_EXECUTED:'+String(process.env.ELECTRON_RUN_AS_NODE))"`,description:'Owned approval probe'}}];
    const message = {id:'msg_probe',type:'message',role:'assistant',model:body.model,content,stop_reason:result?'end_turn':'tool_use',stop_sequence:null,usage:{input_tokens:5,output_tokens:5}};
    if (!body.stream) {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(message));return;}
    res.writeHead(200, {'content-type':'text/event-stream'});
    const event = (type: string, data: Row) => res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    event('message_start',{message:{...message,content:[],stop_reason:null}});
    for (const [index,c] of content.entries()) {
      event('content_block_start',{index,content_block:c.type==='tool_use'?{...c,input:{}}:{...c,text:''}});
      event('content_block_delta',{index,delta:c.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(c.input)}:{type:'text_delta',text:c.text}});
      event('content_block_stop',{index});
    }
    event('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:5}});
    event('message_stop',{});res.end();
  });
  const proxy = createServer((req,res) => { blockedConnections.push(req.url ?? 'unknown');res.writeHead(502);res.end(); });
  proxy.on('connect',(req,socket)=>{blockedConnections.push(req.url??'CONNECT');socket.end('HTTP/1.1 502 Blocked\r\n\r\n');});
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
  const modelPort = (model.address() as {port:number}).port;
  const proxyPort = (proxy.address() as {port:number}).port;
  const receipt = join(root, 'receipt.json');
  const launcher = join(root, 'launcher.json');
  const config = join(root, 'bridge.json');
  const bridge = fileURLToPath(new URL('./claude-approval-bridge.mjs', import.meta.url));
  writeFileSync(config, JSON.stringify({...options, modelUrl:'http://127.0.0.1:'+modelPort,
    proxyUrl:'http://127.0.0.1:'+proxyPort,receipt,launcher}));
  const parent = {...cleanParent(root),PRISM_FAKE_ELECTRON_NODE:realNode};
  const errors: string[] = [];
  let asked=0, exitCode: number|null=null;
  let resolveClosed!:()=>void;
  const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
  const driver = new ClaudeDriver({
    cwd:root,binary:realNode,binaryArgs:[bridge,config],parentEnv:parent,allowEnv:['PRISM_FAKE_ELECTRON_NODE'],
    credentials:{mode:'apiKey',apiKey:'prism-fake-not-a-real-key',home},model:'claude-sonnet-4-6',
    permissionMode:'bypassPermissions',permissionPrompts:{tools:['Bash'],timeoutSeconds:options.captureLauncher?20:5,...(options.nodeOverride?{nodePath:realNode}:{})},
  }, {
    onProtocolError:reason=>errors.push(reason),
    onExit:code=>{exitCode=code;resolveClosed();},
    onRequestPermission:async()=>{
      asked++;
      if(options.scenario==='callback-crash')throw new Error('owned callback error');
      if(options.scenario==='channel-hang')return new Promise(()=>{});
      return options.scenario==='deny'?{outcome:'selected',optionId:'reject_once',reason:DENY_REASON}
        :options.scenario==='cancel'?{outcome:'cancelled'}:{outcome:'selected',optionId:'allow_once',reason:ALLOW_REASON};
    },
  });
  try {
    const execDescriptor=Object.getOwnPropertyDescriptor(process,'execPath')!;
    const versionDescriptor=Object.getOwnPropertyDescriptor(process.versions,'electron');
    Object.defineProperty(process,'execPath',{...execDescriptor,value:options.electron});
    Object.defineProperty(process.versions,'electron',{configurable:true,value:'fixture'});
    try {driver.start();} finally {
      Object.defineProperty(process,'execPath',execDescriptor);
      if(versionDescriptor)Object.defineProperty(process.versions,'electron',versionDescriptor);else delete process.versions.electron;
    }
    // The actual driver must hold this immediate prompt and EOF until the real initialize version is validated.
    driver.prompt('Run the owned Bash probe.');driver.endInput();
    await bounded(closed,45000,'native Claude approval probe timed out');
    const metadata=JSON.parse(readFileSync(receipt,'utf8'));
    const results=requests.flatMap(r=>r.messages.flatMap((m:Row)=>Array.isArray(m.content)?m.content.filter((c:Row)=>c.type==='tool_result'):[]));
    const text=JSON.stringify(results);
    return {scenario:options.scenario,mutation:options.mutation??null,versionFault:options.versionFault??null,
      asked,requests:requests.length,executed:text.includes('PRISM_HOOK_EXECUTED:'),
      cleanGrandchild:text.includes('PRISM_HOOK_EXECUTED:undefined'),providerFlag:metadata.providerFlag,
      toolResults:results,launcher:existsSync(launcher)?JSON.parse(readFileSync(launcher,'utf8')):null,
      nativeCode:metadata.nativeCode,driverExit:exitCode,errors,reportedVersions:metadata.versions,
      sentUsers:metadata.sent.filter((f:Row)=>f.type==='user').length,blockedConnections};
  } finally {
    const stop=await driver.stop({graceMs:0});
    model.closeAllConnections();model.close();proxy.closeAllConnections();proxy.close();
    rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
    assert(stop.verified&&stop.empty&&stop.survivors===0,'approval probe left an unverified/nonempty process tree');
    console.info(JSON.stringify({approvalStopReceipts:1,verified:true,empty:true,survivors:0}));
  }
}

export function assertApprovalResult(result: Awaited<ReturnType<typeof probeClaudeApproval>>, allow: boolean): void {
  assert.equal(result.nativeCode,0,'native CLI exit');
  assert.equal(result.requests,2,'native CLI completed the tool roundtrip');
  assert.equal(result.executed,allow,'approval did not enforce the decision');
  assert.equal(result.providerFlag,null,'Electron mode leaked to provider');
  assert.equal(result.sentUsers,1,'driver sent the held prompt once');
  assert.equal(result.reportedVersions[0]?.source,'control.initialize');
  assert.equal(result.reportedVersions[0]?.version,'2.1.310');
  if(allow){assert(result.cleanGrandchild,'Electron mode leaked to native Bash grandchild');assert.equal(result.asked,1);}
  else assert(!JSON.stringify(result.toolResults).includes('PRISM_HOOK_EXECUTED:'),'denied tool produced output');
}
