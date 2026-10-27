import { describe, expect, it } from 'vitest';
import { META_REPLAY, META_REPLAY_SUMMARY } from '../src/meta.js';
import { openCodexToolProbe } from './fixtures/codex-native-tools-probe.js';

// Same pinned native CLI/owned homes/fake model contract as the native-tool suite. Ordinary resume is intentional:
// nativeTools:'none' still refuses all resumed threads because their restriction provenance is unproved.
describe.runIf(process.env.PRISM_ACP_CODEX_NATIVE_TOOLS==='1')('native Codex0.163.0 replay control',()=>{
  for(const replayHistory of [undefined,false])it(`resumes saved context and continues with history projection ${String(replayHistory)}`,async()=>{
    const first=await openCodexToolProbe({model:'gpt-5.3-codex',noMcp:true});
    let resumed:Awaited<ReturnType<typeof openCodexToolProbe>>|undefined;
    try {
      await first.turn();
      expect(first.requests).toHaveLength(1);
      expect(JSON.stringify(first.requests[0].input)).not.toContain('Local fixture complete');
      const id=first.driver.cliSessionId;expect(id).toBeTypeOf('string');
      await first.cleanup(true);
      resumed=await openCodexToolProbe({model:'gpt-5.3-codex',noMcp:true,reuseHome:first.home,resumeSessionId:id!,...(replayHistory===undefined?{}:{replayHistory})});
      expect(resumed.problems).toEqual([]);expect(resumed.driver.cliSessionId).toBe(id);
      expect(resumed.sent.filter(f=>f.method==='thread/resume')).toHaveLength(1);
      expect(resumed.sent.find(f=>f.method==='thread/resume')?.params.excludeTurns).toBe(true);
      const historyCalls=resumed.sent.filter(f=>f.method==='thread/turns/list'||f.method==='thread/items/list');
      const projected=resumed.updates.filter(u=>u._meta?.[META_REPLAY]===true);
      const summaries=projected.filter(u=>u._meta?.[META_REPLAY_SUMMARY]!==undefined);
      if(replayHistory===false){
        expect(historyCalls).toHaveLength(0);expect(projected).toHaveLength(0);
        expect(resumed.updates.filter(u=>['agent_message_chunk','user_message_chunk','agent_thought_chunk','tool_call','tool_call_update','compaction_update'].includes(u.sessionUpdate))).toHaveLength(0);
      }else{
        expect(historyCalls.some(f=>f.method==='thread/turns/list')).toBe(true);
        expect(historyCalls.some(f=>f.method==='thread/items/list')).toBe(true);
        expect(summaries).toHaveLength(1);
        expect(projected.some(u=>u.sessionUpdate==='agent_message_chunk'&&u.content?.text==='Local fixture complete')).toBe(true);
      }
      const beforeTurn=resumed.updates.length;
      await resumed.turn();
      expect(resumed.requests).toHaveLength(1);
      const remembered=resumed.requests[0].input.filter((item:Record<string,unknown>)=>item.role==='assistant'&&JSON.stringify(item).includes('Local fixture complete'));
      expect(remembered.length).toBeGreaterThan(0); // Native conversation context survives without either listing RPC.
      expect(resumed.updates.slice(beforeTurn).some(u=>u.sessionUpdate==='agent_message_chunk')).toBe(true);
      expect(resumed.updates.slice(beforeTurn).some(u=>u._meta?.[META_REPLAY]===true)).toBe(false);
      console.info(JSON.stringify({codexReplayControl:{replayHistory:replayHistory??'default',resumed:true,historyRpcCount:historyCalls.length,replayedUpdates:projected.length,summaryCount:summaries.length,savedAssistantInNextRequest:true,liveUpdatesRemainLive:true}}));
    } finally {await resumed?.cleanup();await first.cleanup();}
  },90000);
});
