import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeDriver, type TurnOutcome } from '../src/claude/driver.js';
import { launchProvider } from '../src/process-tree.js';
import { encodeLine } from '../src/ndjson.js';

vi.mock('../src/process-tree.js',async()=>({...await vi.importActual<typeof import('../src/process-tree.js')>('../src/process-tree.js'),launchProvider:vi.fn()}));
vi.mock('../src/private-directory.js',()=>({restrictToCurrentUser:()=>{}}));
const drivers: ClaudeDriver[]=[];
afterEach(()=>{for(const driver of drivers.splice(0))driver.kill();vi.useRealTimers();vi.mocked(launchProvider).mockReset();});

function fixture(hooks=true){
  class Child extends EventEmitter {
    stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();exitCode:number|null=null;
    sent: any[]=[];
    constructor(){super();this.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))if(line)this.sent.push(JSON.parse(line));});}
    close(){if(this.exitCode!==null)return;this.exitCode=1;this.emit('close',1,null);}
  }
  const child=new Child();
  const stop=vi.fn(async()=>{child.close();return {graceful:false,verified:true,empty:true,survivors:0};});
  vi.mocked(launchProvider).mockReturnValue({child,started:Promise.resolve({providerPid:1,supervisorPid:2,containment:{kind:'process-group'}}),stop,kill:()=>child.close()} as never);
  const errors:string[]=[],outcomes:TurnOutcome[]=[];
  const driver=new ClaudeDriver({cwd:process.cwd(),...(hooks?{permissionPrompts:{tools:['Bash']}}:{})},{onProtocolError:reason=>errors.push(reason),onTurnEnd:outcome=>outcomes.push(outcome)});
  drivers.push(driver);driver.start();
  const reply=(version:unknown,subtype='success')=>child.stdout.write(encodeLine({type:'control_response',response:{subtype,request_id:child.sent[0].request_id,response:{models:[{value:'fixture',displayName:'Fixture'}],...(version===undefined?{}:{claude_code_version:version})}}}));
  const init=(version:unknown)=>child.stdout.write(encodeLine({type:'system',subtype:'init',claude_code_version:version}));
  return {driver,child,reply,init,errors,outcomes,stop,users:()=>child.sent.filter(f=>f.type==='user')};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};

describe('Claude approval version gate before any prompt',()=>{
  for(const version of ['2.1.295','2.1.309','2.1.310','2.2.0','3.0.0'])it(`accepts documented onFailure version ${version}`,async()=>{
    const f=fixture();f.driver.prompt('held');f.driver.endInput();
    expect(f.users()).toHaveLength(0);expect(f.child.stdin.writableEnded).toBe(false);
    f.reply(version);await flush();
    expect(f.users()).toHaveLength(1);expect(f.child.stdin.writableEnded).toBe(true);expect(f.stop).not.toHaveBeenCalled();
  });
  for(const version of [undefined,null,{},'','2.1.294','2.0.999','1.99.999','2.1.310-dev','not-a-version','2.1.999999999999999999999'])it(`refuses missing/old/opaque version ${JSON.stringify(version)} without sending a prompt`,async()=>{
    const f=fixture();f.driver.prompt('never sent');f.reply(version);await flush();
    expect(f.users()).toHaveLength(0);expect(f.stop).toHaveBeenCalled();expect(f.errors.join(' ')).toMatch(/permission prompts require/);
    expect(f.outcomes).toHaveLength(1);expect(f.outcomes[0]).toMatchObject({isError:true,stopReason:'refusal'});
    expect(()=>f.driver.prompt('still forbidden')).toThrow(/permission prompts/);
  });
  it('initialize error never falls back to sending the queued prompt',async()=>{
    const f=fixture();f.driver.prompt('never sent');f.reply('2.1.310','error');await flush();
    expect(f.users()).toHaveLength(0);expect(f.stop).toHaveBeenCalled();expect(f.errors.join(' ')).toMatch(/initialize failed/);
  });
  it('initialize timeout never falls back to sending the queued prompt',async()=>{
    vi.useFakeTimers();const f=fixture();f.driver.prompt('never sent');
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.users()).toHaveLength(0);expect(f.stop).toHaveBeenCalled();expect(f.errors.join(' ')).toMatch(/timed out/);
  });
  for(const version of [undefined,'2.1.309','unparseable'])it(`a later missing/changed system/init version closes the session (${String(version)})`,async()=>{
    const f=fixture();f.reply('2.1.310');await flush();f.init(version);
    expect(f.stop).toHaveBeenCalled();expect(f.errors.join(' ')).toMatch(/system\/init omitted or changed/);
    expect(()=>f.driver.prompt('forbidden')).toThrow(/system\/init/);
  });
  it('an early system/init cannot disagree with control initialize',async()=>{
    const f=fixture();f.driver.prompt('held');f.init('2.1.309');f.reply('2.1.310');await flush();
    expect(f.users()).toHaveLength(0);expect(f.stop).toHaveBeenCalled();
  });
  it('a success result in the same chunk cannot override a fatal version mismatch',async()=>{
    const f=fixture();f.driver.prompt('held');f.reply('2.1.310');await flush();
    f.child.stdout.write(encodeLine({type:'system',subtype:'init',claude_code_version:'2.1.309'})+encodeLine({type:'result',subtype:'success',is_error:false,stop_reason:'end_turn'}));
    expect(f.outcomes).toHaveLength(1);expect(f.outcomes[0]).toMatchObject({stopReason:'refusal',isError:true});
  });
  it('cancel removes a held prompt and leaves the initialized process usable',async()=>{
    const f=fixture();f.driver.prompt('cancel me');await f.driver.cancel();f.reply('2.1.310');await flush();
    expect(f.users()).toHaveLength(0);expect(f.outcomes[0].stopReason).toBe('cancelled');
    f.driver.prompt('new prompt');expect(f.users()).toHaveLength(1);
  });
  it('stop prevents a late initialize answer from releasing a held prompt',async()=>{
    const f=fixture();f.driver.prompt('held');await f.driver.stop({graceMs:0});f.reply('2.1.310');await flush();expect(f.users()).toHaveLength(0);
  });
  it('ordinary driver startup remains promptable without a version declaration',async()=>{
    const f=fixture(false);f.driver.prompt('ordinary');expect(f.users()).toHaveLength(1);f.reply(undefined);await flush();expect(f.stop).not.toHaveBeenCalled();
  });
  it('refuses a relative trusted Node path',()=>{expect(()=>new ClaudeDriver({cwd:process.cwd(),permissionPrompts:{tools:['Bash'],nodePath:'node'}})).toThrow(/absolute/);});
});
