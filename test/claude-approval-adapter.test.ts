import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeDriver } from '../src/claude/driver.js';
import { prepareProcessTree, windowsApprovalAdapter } from '../src/process-tree.js';

describe.runIf(process.platform==='win32')('native approval adapter startup refusal',()=>{
  let root:string;
  beforeAll(()=>{root=mkdtempSync(join(tmpdir(),'prism-approval-build-'));});
  afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  for(const altered of [false,true])it(`${altered?'unverified altered':'missing'} adapter plus unavailable compiler refuses before any CLI/configuration`,async()=>{
    const cache=join(root,altered?'altered':'missing');
    if(altered){await prepareProcessTree({directory:cache});appendFileSync(windowsApprovalAdapter(),'unverified bytes');}
    const previous=process.env.SystemRoot;
    process.env.SystemRoot=root; // An owned path with no compiler/Windows helpers.
    const marker=join(root,altered?'altered-ran':'missing-ran');
    const script=join(root,'provider-'+String(altered)+'.mjs');
    writeFileSync(script,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'must not run');`);
    try {
      await expect(prepareProcessTree({directory:cache})).rejects.toThrow(/csc\.exe/);
      const driver=new ClaudeDriver({cwd:root,binary:process.execPath,binaryArgs:[script],permissionPrompts:{tools:['Bash']}});
      expect(()=>driver.start()).toThrow(/cannot prepare Claude approval adapter/);
      expect(driver.processTree).toBe(null);expect(existsSync(marker)).toBe(false);
    } finally {
      if(previous===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=previous;
      await prepareProcessTree({directory:cache});
    }
  },60000);
});
