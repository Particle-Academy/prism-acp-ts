import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { measureNativeCase, timedExecFileSync } from '../test/fixtures/windows-native-timing.mjs';
const original = childProcess.execFileSync;
childProcess.execFileSync = (...args) => timedExecFileSync(original, ...args);
syncBuiltinESMExports();
try {
  const { prepareProcessTree } = await import('../dist/process-tree.js');
  // prepareProcessTree defers with setImmediate; measure only the synchronous preparation call it uses.
  const { windowsApprovalAdapter } = await import('../dist/process-tree.js');
  process.env.PRISM_ACP_NATIVE_VARIANT = 'warmup';
  measureNativeCase(Number(process.env.PRISM_ACP_NATIVE_SAMPLE), () => windowsApprovalAdapter());
  await prepareProcessTree();
} finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
