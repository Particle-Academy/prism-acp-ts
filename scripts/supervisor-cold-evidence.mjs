import { join } from 'node:path';

const sha256 = /^[0-9a-f]{64}$/;

// Compile the released publisher and its actual imports. New unrelated
// consumers may require exports the immutable old publisher never provided.
export function coldBaselineConfig(project, root) {
  return { extends: join(root, 'tsconfig.json'), compilerOptions: { rootDir: join(project, 'src'), outDir: join(project, 'dist'), typeRoots: [join(root, 'node_modules', '@types')] }, include: [join(project, 'src', 'process-tree.ts')] };
}

// Classify only the two integrity checks actually executed by the cold worker.
// A timeout, invalid approval result or arbitrary exception is not hash evidence.
export function coldHashFailureKind(receipt) {
  if (!receipt || receipt.coldWorker !== true || receipt.success !== false) return null;
  if (receipt.name === 'ProcessTreeError' && /supervisor does not match the hash recorded when it was built/.test(receipt.message || '')) return 'supervisor-guard';
  if (receipt.name === 'Error' && receipt.code === 'adapter_receipt_hash_mismatch' &&
      sha256.test(receipt.observedSha256 || '') && sha256.test(receipt.recordedSha256 || '') &&
      receipt.observedSha256 !== receipt.recordedSha256) return 'adapter-receipt';
  return null;
}
