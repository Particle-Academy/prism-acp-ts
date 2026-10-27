const sha256 = /^[0-9a-f]{64}$/;

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
