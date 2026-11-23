import { describe, expect, it } from 'vitest';
import {
  AcpAgent,
  ALLOW_ONCE_OR_DENY,
  askPermission,
  CLAUDE_DRIVER_CAPABILITIES,
  CODEX_DRIVER_CAPABILITIES,
  permissionDecision,
  type AgentDriver,
  type DriverCapabilities,
  type DriverEvents,
  type PermissionDecision,
  type PermissionRequest,
} from '../src/index.js';
import { JsonRpcPeer, RPC_METHOD_NOT_FOUND } from '../src/jsonrpc.js';

/**
 * The contract a driver written OUTSIDE this package relies on. Everything here is imported from the public entry,
 * because that is the only thing such a driver can reach: a rule it has to copy is a rule that drifts.
 */

const REQUEST: PermissionRequest = {
  toolCall: { toolCallId: 'tool_1', title: 'write_file', rawInput: { path: 'a.txt' } },
  options: ALLOW_ONCE_OR_DENY,
};

describe('permissionDecision: only an offered allow_once allows', () => {
  it('allows an explicit allow_once that was offered, with the client reason when it gave one', () => {
    expect(permissionDecision(REQUEST, { outcome: 'selected', optionId: 'allow_once' })).toEqual({ allow: true, reason: 'Allowed by the person.' });
    expect(permissionDecision(REQUEST, { outcome: 'selected', optionId: 'allow_once', reason: 'auto-approved' })).toEqual({ allow: true, reason: 'auto-approved' });
    expect(permissionDecision(REQUEST.options, { outcome: 'selected', optionId: 'allow_once' }).allow).toBe(true);
  });

  it('denies an offered reject, with the client reason when it gave one', () => {
    expect(permissionDecision(REQUEST, { outcome: 'selected', optionId: 'reject_once' })).toEqual({ allow: false, reason: 'The person denied this tool call.' });
    expect(permissionDecision(REQUEST, { outcome: 'selected', optionId: 'reject_once', reason: 'over budget' })).toEqual({ allow: false, reason: 'over budget' });
  });

  it('denies an option id that was not offered, and ignores its reason', () => {
    for (const optionId of ['allow_always', 'allow', 'yes', '']) {
      const d = permissionDecision(REQUEST, { outcome: 'selected', optionId, reason: 'Allowed by the person.' });
      expect(d.allow, optionId).toBe(false);
      expect(d.reason, optionId).toBe('The answer named an option that was not offered.');
    }
  });

  it('denies allow_once when the request did not offer it', () => {
    const rejectOnly = [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }];
    expect(permissionDecision(rejectOnly, { outcome: 'selected', optionId: 'allow_once' }).allow).toBe(false);
    expect(permissionDecision([], { outcome: 'selected', optionId: 'allow_once' }).allow).toBe(false);
  });

  it('denies look-alike ids: case, padding, invisible and homoglyph characters', () => {
    for (const optionId of ['ALLOW_ONCE', 'Allow_once', ' allow_once', 'allow_once ', 'allow_once\n', 'allow_once​', '﻿allow_once', 'allow_oncе', 'allow‐once', 'allow-once']) {
      expect(permissionDecision(REQUEST, { outcome: 'selected', optionId }).allow, JSON.stringify(optionId)).toBe(false);
    }
  });

  it('allows by the offered option KIND, never by the id string alone', () => {
    const relabelled = [{ optionId: 'allow_once', name: 'Allow once', kind: 'reject_once' }, { optionId: 'go', name: 'Go', kind: 'allow_once' }];
    expect(permissionDecision(relabelled, { outcome: 'selected', optionId: 'allow_once' }).allow).toBe(false);
    expect(permissionDecision(relabelled, { outcome: 'selected', optionId: 'go' }).allow).toBe(true);
    const always = [{ optionId: 'allow_always', name: 'Always', kind: 'allow_always' }];
    expect(permissionDecision(always, { outcome: 'selected', optionId: 'allow_always' }).allow).toBe(false);
  });

  it('denies an id offered twice, because the answer is ambiguous', () => {
    const twice = [{ optionId: 'x', name: 'Allow', kind: 'allow_once' }, { optionId: 'x', name: 'Deny', kind: 'reject_once' }];
    expect(permissionDecision(twice, { outcome: 'selected', optionId: 'x' }).allow).toBe(false);
  });

  it('denies a cancel, with the client reason when it gave one', () => {
    expect(permissionDecision(REQUEST, { outcome: 'cancelled' })).toEqual({ allow: false, reason: 'The request was cancelled.' });
    expect(permissionDecision(REQUEST, { outcome: 'cancelled', reason: 'turn stopped' })).toEqual({ allow: false, reason: 'turn stopped' });
  });

  it('denies a malformed answer with a fixed reason', () => {
    const malformed: unknown[] = [
      null, undefined, 'allow_once', 42, true, [], ['allow_once'],
      {}, { outcome: 'selected' }, { outcome: 'selected', optionId: 1 }, { outcome: 'selected', optionId: null },
      { outcome: 'allowed', optionId: 'allow_once' }, { outcome: 'SELECTED', optionId: 'allow_once' }, { optionId: 'allow_once' },
      { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    ];
    for (const answer of malformed) {
      expect(permissionDecision(REQUEST, answer), JSON.stringify(answer)).toEqual({ allow: false, reason: 'No valid approval was received.' });
    }
  });

  it('denies when the offered options are malformed', () => {
    for (const offered of [null, undefined, 'allow_once', {}, [null], [{ optionId: 'allow_once' }]]) {
      expect(permissionDecision(offered as never, { outcome: 'selected', optionId: 'allow_once' }).allow, JSON.stringify(offered)).toBe(false);
    }
  });

  it('denies a client error and a missing client through askPermission', async () => {
    const failing = async (): Promise<never> => { throw new Error('transport closed'); };
    expect(await askPermission(failing, REQUEST)).toEqual({ allow: false, reason: 'No valid approval was received.' });
    const throwing = (): never => { throw new Error('sync'); };
    expect(await askPermission(throwing as never, REQUEST)).toEqual({ allow: false, reason: 'No valid approval was received.' });
    expect(await askPermission(undefined, REQUEST)).toEqual({ allow: false, reason: 'No one could be asked to approve this tool call.' });
    expect(await askPermission(async () => ({ outcome: 'selected', optionId: 'allow_once' }), REQUEST)).toEqual({ allow: true, reason: 'Allowed by the person.' });
  });

  it('offers exactly Allow once and Deny, frozen so a driver cannot widen them for everyone', () => {
    expect(ALLOW_ONCE_OR_DENY.map((o) => [o.optionId, o.kind])).toEqual([['allow_once', 'allow_once'], ['reject_once', 'reject_once']]);
    expect(Object.isFrozen(ALLOW_ONCE_OR_DENY)).toBe(true);
    expect(ALLOW_ONCE_OR_DENY.every((o) => Object.isFrozen(o))).toBe(true);
  });
});

/** A driver built the way an external one is: it asks through DriverEvents and decides with the exported rule. */
class AskingDriver implements AgentDriver {
  readonly cliSessionId = null;
  readonly withheldCredentials: readonly string[] = [];
  readonly decisions: PermissionDecision[] = [];
  constructor(readonly events: DriverEvents) {}
  start(): void {}
  prompt(): void {
    void askPermission(this.events.onRequestPermission, REQUEST).then((decision) => {
      this.decisions.push(decision);
      this.events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: 'end_turn' });
    });
  }
  endInput(): void {}
  kill(): void {}
}

function harness(driverCapabilities?: DriverCapabilities) {
  const sent: Record<string, unknown>[] = [];
  const drivers: AskingDriver[] = [];
  const built: unknown[] = [];
  const peer = new JsonRpcPeer({ send: (m) => sent.push(m as Record<string, unknown>) });
  new AcpAgent(peer, {
    driverFactory: (options, events) => {
      built.push(options);
      const driver = new AskingDriver(events);
      drivers.push(driver);
      return driver;
    },
    newSessionId: () => 'sess_ext',
    ...(driverCapabilities === undefined ? {} : { driverCapabilities }),
  });
  const call = async (method: string, params: unknown, id: number): Promise<Record<string, unknown>> => {
    const before = sent.length;
    await peer.receive({ jsonrpc: '2.0', id, method, params });
    return sent.slice(before).find((m) => m.id === id) ?? {};
  };
  return { peer, sent, drivers, built, call };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the permission round trip at the ACP boundary', () => {
  // Each answer is what an ACP client sends back to session/request_permission, over JSON-RPC.
  const answers: [string, Record<string, unknown>, boolean][] = [
    ['explicit allow_once', { result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } }, true],
    ['reject_once', { result: { outcome: { outcome: 'selected', optionId: 'reject_once' } } }, false],
    ['unoffered option', { result: { outcome: { outcome: 'selected', optionId: 'allow_always' } } }, false],
    ['look-alike id', { result: { outcome: { outcome: 'selected', optionId: 'allow_once​' } } }, false],
    ['homoglyph id', { result: { outcome: { outcome: 'selected', optionId: 'allow_oncе' } } }, false],
    ['cancel', { result: { outcome: { outcome: 'cancelled' } } }, false],
    ['malformed result', { result: { outcome: 'allow_once' } }, false],
    ['empty result', { result: null }, false],
    ['client error', { error: { code: -32000, message: 'client blew up' } }, false],
  ];

  for (const [label, answer, allowed] of answers) {
    it(`${allowed ? 'allows' : 'denies'}: ${label}`, async () => {
      const h = harness({ permissionRequests: true, transcriptReplay: false });
      await h.call('initialize', {}, 1);
      await h.call('session/new', { cwd: process.cwd(), mcpServers: [] }, 2);
      const prompt = h.peer.receive({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'sess_ext', prompt: [{ type: 'text', text: 'go' }] } });
      await tick();
      const asked = h.sent.find((m) => m.method === 'session/request_permission');
      expect(asked).toBeDefined();
      await h.peer.receive({ jsonrpc: '2.0', id: asked!.id as number, ...answer });
      await prompt;
      await tick();
      expect(h.drivers[0]!.decisions).toHaveLength(1);
      expect(h.drivers[0]!.decisions[0]!.allow).toBe(allowed);
    });
  }
});

describe('loadSession is the driver\'s claim', () => {
  const nonResumable: DriverCapabilities = { permissionRequests: true, transcriptReplay: false, loadSession: false };

  it('advertises loadSession false for a driver that declares it cannot resume', async () => {
    const h = harness(nonResumable);
    const result = (await h.call('initialize', {}, 1)).result as Record<string, Record<string, unknown>>;
    expect(result.agentCapabilities!.loadSession).toBe(false);
  });

  it('advertises loadSession true for the Claude and Codex drivers', async () => {
    expect(CLAUDE_DRIVER_CAPABILITIES.loadSession).toBe(true);
    expect(CODEX_DRIVER_CAPABILITIES.loadSession).toBe(true);
    for (const capabilities of [CLAUDE_DRIVER_CAPABILITIES, CODEX_DRIVER_CAPABILITIES]) {
      const h = harness(capabilities);
      const result = (await h.call('initialize', {}, 1)).result as Record<string, Record<string, unknown>>;
      expect(result.agentCapabilities!.loadSession).toBe(true);
    }
  });

  it('refuses session/load cleanly against a non-resumable driver, and builds no driver', async () => {
    const h = harness(nonResumable);
    await h.call('initialize', {}, 1);
    const reply = await h.call('session/load', { sessionId: '3f1c2a8e-0000-4000-8000-000000000000', cwd: process.cwd(), mcpServers: [] }, 2);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toEqual({ code: RPC_METHOD_NOT_FOUND, message: 'this agent cannot resume a session: it advertises loadSession false' });
    expect(h.built).toEqual([]);
    // The refusal does not depend on the params being well formed.
    const bare = await h.call('session/load', {}, 3);
    expect((bare.error as Record<string, unknown>)?.code).toBe(RPC_METHOD_NOT_FOUND);
    expect(h.built).toEqual([]);
  });

  it('still opens new sessions on a non-resumable driver', async () => {
    const h = harness(nonResumable);
    const reply = await h.call('session/new', { cwd: process.cwd(), mcpServers: [] }, 1);
    expect(reply.result).toEqual({ sessionId: 'sess_ext' });
    expect(h.built).toHaveLength(1);
  });
});
