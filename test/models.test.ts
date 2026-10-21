import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeDriver } from '../src/claude/driver.js';
import { claudeModelsOf, codexModelsOf, listModels } from '../src/models.js';

/**
 * THE MODEL PICKER SHOWS WHAT THE PROVIDER OFFERS (tynn, for the owner, 2026-10-21: "I do not even see fable as an
 * option"). Genie's picker was a hardcoded `['sonnet', 'opus', 'haiku']`.
 *
 * claude-initialize-models.json is the `models` array of a REAL control `initialize` answer (claude-code 2.1.301,
 * 2026-10-21, scripts/probe-claude-models.mjs), with nothing else from the answer kept: it also carries the account,
 * commands, agents and paths. The stand-in CLI below answers with exactly that list.
 */
const MEASURED = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/claude-initialize-models.json', import.meta.url)), 'utf8')) as {
  models: Record<string, unknown>[];
};
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'prism-models-')); dirs.push(d); return d; };

async function until<T>(what: string, read: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A Claude CLI stand-in that speaks the control protocol: initialize -> the measured models; set_model -> success,
 * or an error for the model named `refuse-me`. Every control request it receives is appended to a log. */
function claudeStandIn(): { script: string; log: string } {
  const dir = tmp();
  const script = join(dir, 'claude.mjs');
  const log = join(dir, 'requests.jsonl');
  writeFileSync(script, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const models = ${JSON.stringify(MEASURED.models)};
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.type !== 'control_request') return;
  appendFileSync(${JSON.stringify(log)}, line + '\\n');
  const { request_id, request } = frame;
  if (request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id, response: { models, account: { email: 'must-never-surface@example.com' } } } });
  } else if (request.subtype === 'set_model') {
    out(request.model === 'refuse-me'
      ? { type: 'control_response', response: { subtype: 'error', request_id, error: 'unknown model' } }
      : { type: 'control_response', response: { subtype: 'success', request_id } });
  }
});
`);
  return { script, log };
}
const requestsIn = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

describe('what the providers answer, parsed', () => {
  it('Claude: every measured model, Fable included, with name, description and the model an alias resolves to', () => {
    const models = claudeModelsOf(MEASURED);
    expect(models).toHaveLength(MEASURED.models.length);
    expect(models.map((m) => m.modelId)).toContain('fable');
    expect(models.find((m) => m.modelId === 'fable')).toEqual({
      modelId: 'fable', name: 'Fable 5.1', description: 'For your toughest challenges', resolvedModel: 'claude-fable-5-1',
    });
    expect(models.find((m) => m.modelId === 'default')?.isDefault).toBe(true);
  });

  it('Codex: hidden models stay out unless asked for; the default is marked', () => {
    const page = { data: [
      { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Latest workhorse model.', isDefault: true, hidden: false },
      { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast.', isDefault: false, hidden: false },
      { id: 'internal-preview', model: 'internal-preview', displayName: 'Preview', description: '', isDefault: false, hidden: true },
    ] };
    expect(codexModelsOf(page).map((m) => m.modelId)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(codexModelsOf(page, true).map((m) => m.modelId)).toContain('internal-preview');
    expect(codexModelsOf(page)[0]).toEqual({ modelId: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model.', isDefault: true });
  });

  it('provider text is cleaned and an unusable id is left out, never guessed at', () => {
    const models = claudeModelsOf({ models: [
      { value: 'ok', displayName: 'Shown\u001b[31m red\u001b[0m' },
      { value: '--dangerous-flag', displayName: 'Would be an argument' },
      { value: 42 },
      { displayName: 'No id' },
    ] });
    expect(models).toEqual([{ modelId: 'ok', name: 'Shown red' }]);
  });
});

describe('ClaudeDriver, through a stand-in CLI that speaks the control protocol', () => {
  it('lists the account\'s models without running a turn, and switches the live session', async () => {
    const { script, log } = claudeStandIn();
    const driver = new ClaudeDriver({ cwd: tmp(), binary: process.execPath, binaryArgs: [script] }, {});
    driver.start();
    try {
      const state = await driver.modelState();
      expect(state.availableModels.map((m) => m.modelId)).toContain('fable');
      expect(state.currentModelId).toBe('default');
      expect(JSON.stringify(state)).not.toContain('must-never-surface');

      await driver.setModel('fable');
      expect((await driver.modelState()).currentModelId).toBe('fable');
      const sent = await until('set_model', () => requestsIn(log).find((r) => r.request.subtype === 'set_model'));
      expect(sent.request).toEqual({ subtype: 'set_model', model: 'fable' });
      expect(requestsIn(log).map((r) => r.request.subtype)).toEqual(['initialize', 'set_model']);
    } finally {
      await driver.stop({ graceMs: 0 });
    }
  });

  it('a refused switch rejects and leaves the current model as it was; a flag-shaped id is never sent', async () => {
    const { script, log } = claudeStandIn();
    const driver = new ClaudeDriver({ cwd: tmp(), binary: process.execPath, binaryArgs: [script], model: 'sonnet' }, {});
    driver.start();
    try {
      expect((await driver.modelState()).currentModelId).toBe('sonnet');
      await expect(driver.setModel('refuse-me')).rejects.toThrow(/refused/);
      await expect(driver.setModel('--dangerous')).rejects.toThrow(/refusing model/);
      expect((await driver.modelState()).currentModelId).toBe('sonnet');
      expect(requestsIn(log).map((r) => r.request.model).filter(Boolean)).toEqual(['refuse-me']);
    } finally {
      await driver.stop({ graceMs: 0 });
    }
  });
});

describe('listModels(), before any session exists', () => {
  it('Claude: the account\'s list, from a short-lived CLI that is ended afterwards', async () => {
    const { script } = claudeStandIn();
    const state = await listModels('claude', { binary: process.execPath, binaryArgs: [script], cwd: tmp() });
    expect(state.availableModels.map((m) => m.modelId)).toEqual(MEASURED.models.map((m) => m.value));
    expect(state.currentModelId).toBe('default');
  });

  it('Codex: pages through model/list after the handshake', async () => {
    const dir = tmp();
    const script = join(dir, 'codex.mjs');
    writeFileSync(script, `
import { createInterface } from 'node:readline';
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return out({ jsonrpc: '2.0', id, result: {} });
  if (method === 'model/list' && params.cursor === null) return out({ jsonrpc: '2.0', id, result: { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Workhorse.', isDefault: true, hidden: false }], nextCursor: 'page-2' } });
  if (method === 'model/list') return out({ jsonrpc: '2.0', id, result: { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast.', isDefault: false, hidden: false }], nextCursor: null } });
  out({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } });
});
`);
    const state = await listModels('codex', { binary: process.execPath, binaryArgs: [script], cwd: dir });
    expect(state.availableModels.map((m) => m.modelId)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(state.currentModelId).toBe('gpt-6.1-sol');
  });

  it('a CLI that never answers is a ModelListError within the timeout, not a hang', async () => {
    const dir = tmp();
    const script = join(dir, 'silent.mjs');
    writeFileSync(script, 'process.stdin.resume();');
    await expect(listModels('claude', { binary: process.execPath, binaryArgs: [script], cwd: dir, timeoutMs: 500 }))
      .rejects.toThrow(/did not answer/);
  });
});
