import test from 'node:test';
import assert from 'node:assert/strict';
import { coldHashFailureKind } from './supervisor-cold-evidence.mjs';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, ownedProducer } from './supervisor-cold-owned.mjs';

const mismatch = { coldWorker: true, success: false, name: 'Error', code: 'adapter_receipt_hash_mismatch', observedSha256: 'a'.repeat(64), recordedSha256: 'b'.repeat(64) };

test('recognizes the worker independently hashing bytes against the complete receipt', () => {
  assert.equal(coldHashFailureKind(mismatch), 'adapter-receipt');
  assert.equal(coldHashFailureKind({ coldWorker: true, success: false, name: 'ProcessTreeError', message: 'cannot contain the provider: the supervisor does not match the hash recorded when it was built, and could not be replaced' }), 'supervisor-guard');
});

test('owned producer copies preserve publisher bytes and vary only inert supervisor metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'cold-copy-check-'));
  try {
    const source = join(root, 'original'); mkdirSync(source);
    writeFileSync(join(source, 'process-tree.js'), '// exact publisher bytes\n');
    writeFileSync(join(source, 'process-tree-local.js'), '// exact local transport bytes\n');
    const supervisor = 'export const SUPERVISOR_CS = String.raw`using System;\nstatic class Supervisor {}`;\n';
    writeFileSync(join(source, 'process-tree-supervisor-cs.js'), supervisor);
    const first = ownedProducer(pathToFileURL(join(source, 'process-tree.js')).href, join(root, 'first'), '0-0');
    const second = ownedProducer(pathToFileURL(join(source, 'process-tree.js')).href, join(root, 'second'), '0-1');
    assert.equal(first.publisherSha256, second.publisherSha256);
    assert.equal(first.publisherSha256, digest(readFileSync(join(source, 'process-tree.js'))));
    assert.deepEqual(readFileSync(join(root, 'first', 'process-tree.js')), readFileSync(join(source, 'process-tree.js')));
    assert.deepEqual(readFileSync(join(root, 'first', 'process-tree-local.js')), readFileSync(join(source, 'process-tree-local.js')));
    assert.notEqual(first.variantSupervisorSha256, second.variantSupervisorSha256);
    assert.equal(readFileSync(join(source, 'process-tree-supervisor-cs.js'), 'utf8'), supervisor);
    assert.throws(() => ownedProducer(pathToFileURL(join(source, 'process-tree.js')).href, join(root, 'bad'), '"injection'), /invalid/);
  } finally {
    assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()), 'owned fixture cleanup stays inside its temporary parent');
    rmSync(root, { recursive: true, force: true });
  }
});

test('arbitrary failures and unproven or equal digests cannot satisfy the negative control', () => {
  for (const receipt of [null, {}, { ...mismatch, success: true }, { ...mismatch, coldWorker: false },
    { ...mismatch, code: 'timeout' }, { ...mismatch, recordedSha256: mismatch.observedSha256 },
    { ...mismatch, observedSha256: 'not-a-hash' }, { ...mismatch, recordedSha256: undefined },
    { coldWorker: true, success: false, name: 'Error', message: 'adapter hash did not match its complete cache receipt' },
    { coldWorker: true, success: false, name: 'Error', message: 'owned cold workers deadline' },
    { coldWorker: true, success: false, name: 'Error', message: 'native approval adapter did not preserve allow42/deny0 outcomes' }]) {
    assert.equal(coldHashFailureKind(receipt), null);
  }
});
