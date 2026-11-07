/** Steering reports native acceptance and user-item observation, never model obedience or exactly-once delivery. */
export interface SteerOptions {
  /** Fresh UUID, supplied and durably saved with the original input by the host. Native IDs do not deduplicate. */
  readonly clientId: string;
  /** Pin a previously displayed turn. Omitted means the active turn at this call, never a future turn. */
  readonly expectedTurnId?: string;
}

export type SteerRefusal = 'not_ready' | 'session_closed' | 'no_active_turn' | 'turn_id_pending'
  | 'turn_mismatch' | 'cancelling' | 'invalid_input' | 'duplicate_steer_id' | 'capacity_reached'
  | 'native_validation_refused';
export type SteerUncertainty = 'reply_timeout' | 'transport_or_protocol_gap' | 'native_error'
  | 'malformed_reply' | 'missing_correlation' | 'conflicting_item_ids' | 'session_ended';
export type SteerAcceptance =
  | { readonly outcome: 'accepted'; readonly steerId: string; readonly turnId: string }
  | { readonly outcome: 'not_delivered'; readonly steerId: string; readonly reason: SteerRefusal }
  | { readonly outcome: 'unknown'; readonly steerId: string; readonly reason: SteerUncertainty };
export type SteerKind = 'accepted' | 'observed' | 'turn_ended_unobserved' | 'not_delivered' | 'unknown';
export interface SteerRecord {
  /** Equals the host's clientId, sent once as native clientUserMessageId. */
  readonly steerId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly kind: SteerKind;
  readonly acceptance: 'pending' | 'accepted' | 'not_delivered' | 'unknown';
  readonly nativeItemId?: string;
  readonly reason?: SteerRefusal | SteerUncertainty;
  readonly turnStatus?: 'completed' | 'interrupted' | 'failed';
  readonly final: boolean;
}
export type SteerUpdate = SteerRecord | {
  readonly kind: 'late_item_after_final'; readonly steerId: string; readonly nativeItemId: string;
  readonly threadId: string; readonly turnId: string;
};
export type SteerState = SteerRecord | { readonly kind: 'not_known' };
export interface SteeringState {
  readonly supported: boolean;
  readonly cliVersion: string | null;
  readonly activeTurnId: string | null;
  readonly retainedRecords: number;
  readonly capacity: 128;
}
export class SteerUnsupported extends Error {
  readonly code = 'steer_unsupported';
  constructor() { super('This Codex CLI does not support turn/steer (requires >=0.163.0).'); this.name = 'SteerUnsupported'; }
}
export class SteerInputError extends Error {
  readonly code = 'invalid_input';
  constructor() { super('Steering requires a fresh UUID clientId and valid input.'); this.name = 'SteerInputError'; }
}
export function validSteerId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
export function safeNativeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
}
/** Stable releases only; a future prerelease is not evidence of the released protocol. */
export function steeringCliVersion(initialized: unknown): string | null {
  const userAgent = object(initialized)?.userAgent;
  if (typeof userAgent !== 'string') return null;
  return /^[^\s]+\/(\d{1,4}\.\d{1,4}\.\d{1,4})(?:\s|$)/.exec(userAgent)?.[1] ?? null;
}
export function steeringVersionSupported(version: string | null): boolean {
  if (version === null) return false;
  const [major, minor] = version.split('.').map(Number);
  return major! > 0 || minor! >= 163;
}

/** Session-local metadata only. Acknowledgement releases records, never silently evicts them. */
export class SteerLedger {
  readonly #records = new Map<string, SteerRecord>();
  readonly #seen = new Set<string>();
  readonly #ending = new Map<string, { status: 'completed' | 'interrupted' | 'failed'; timer: NodeJS.Immediate; drained: boolean }>();
  readonly #gaps = new Set<string>();
  readonly #lastLateItem = new Map<string, string>();
  constructor(readonly publish: (update: SteerUpdate) => void) {}
  get size(): number { return this.#records.size; }
  state(id: string): SteerState { return this.#records.get(id) ?? Object.freeze({ kind: 'not_known' }); }
  refusal(id: string): 'duplicate_steer_id' | 'capacity_reached' | null {
    return this.#seen.has(id) ? 'duplicate_steer_id' : this.size >= 128 ? 'capacity_reached' : null;
  }
  reserve(steerId: string, threadId: string, turnId: string): void {
    this.#seen.add(steerId);
    this.#records.set(steerId, Object.freeze({ steerId, threadId, turnId, kind: 'unknown', acceptance: 'pending', final: false }));
  }
  acknowledge(id: string): boolean {
    const record = this.#records.get(id);
    if (record === undefined || !record.final || record.acceptance === 'pending') return false;
    this.#records.delete(id);
    this.#lastLateItem.delete(id);
    if (![...this.#records.values()].some(r => r.turnId === record.turnId)) {
      const ending = this.#ending.get(record.turnId);
      if (ending !== undefined) clearImmediate(ending.timer);
      this.#ending.delete(record.turnId); this.#gaps.delete(record.turnId);
    }
    return true;
  }
  accepted(id: string): void {
    const record = this.#records.get(id);
    if (record === undefined) return;
    this.#put({ ...record, acceptance: 'accepted', ...(record.kind === 'unknown' && record.reason === undefined ? { kind: 'accepted' as const } : {}) });
    this.#finishEnding(record.turnId);
  }
  refused(id: string, reason: SteerRefusal): void {
    const record = this.#records.get(id);
    if (record === undefined) return;
    // A contradictory reply cannot erase an already observed native item.
    this.#put(record.kind === 'observed' ? { ...record, acceptance: 'unknown' }
      : { ...record, kind: 'not_delivered', acceptance: 'not_delivered', reason, final: true });
  }
  uncertain(id: string, reason: SteerUncertainty, replySettled = false): void {
    const record = this.#records.get(id);
    if (record === undefined) return;
    if (record.kind === 'turn_ended_unobserved' || record.kind === 'not_delivered') return;
    const acceptance = replySettled && record.acceptance === 'pending' ? 'unknown' : record.acceptance;
    if (record.reason === 'conflicting_item_ids') { this.#put({ ...record, acceptance }); return; }
    this.#put(record.kind === 'observed' ? { ...record, acceptance }
      : { ...record, kind: 'unknown', acceptance, reason, final: true });
  }
  gap(turnId?: string): void {
    for (const record of this.#records.values()) {
      if (turnId !== undefined && record.turnId !== turnId) continue;
      this.#gaps.add(record.turnId);
      this.uncertain(record.steerId, 'transport_or_protocol_gap');
    }
  }
  observe(threadId: unknown, turnId: unknown, item: unknown): void {
    const value = object(item);
    if (value === undefined || typeof value.type !== 'string') { this.gap(); return; }
    if (value.type !== 'userMessage') return;
    const matches = [...this.#records.values()].filter(r => (threadId === undefined || r.threadId === threadId) && (turnId === undefined || r.turnId === turnId));
    if (matches.length === 0) return;
    const id = value.clientId;
    if (!safeNativeId(threadId) || !safeNativeId(turnId) || !validSteerId(id) || !safeNativeId(value.id)) {
      for (const record of matches) if (!record.final || record.kind === 'unknown') this.uncertain(record.steerId, 'missing_correlation');
      return;
    }
    const record = matches.find(r => r.steerId === id);
    if (record === undefined) {
      // An unrelated user input cannot identify which unseen accepted steer was delivered.
      for (const r of matches) if (!r.final) this.uncertain(r.steerId, 'missing_correlation');
      return;
    }
    if (record.kind === 'turn_ended_unobserved' || record.kind === 'not_delivered') {
      if (this.#lastLateItem.get(id) === value.id) return;
      this.#lastLateItem.set(id, value.id);
      this.publish(Object.freeze({ kind: 'late_item_after_final', steerId: id, nativeItemId: value.id, threadId: record.threadId, turnId: record.turnId }));
      return;
    }
    if (record.nativeItemId !== undefined && record.nativeItemId !== value.id) {
      this.#put({ ...record, kind: 'unknown', reason: 'conflicting_item_ids', final: true });
      return;
    }
    if (record.kind === 'observed') return; // started/completed for the same item is one observation.
    if (record.reason === 'conflicting_item_ids') return;
    const { reason: _reason, ...facts } = record;
    this.#put({ ...facts, kind: 'observed', nativeItemId: value.id, final: true });
  }
  end(turnId: string, status: 'completed' | 'interrupted' | 'failed'): void {
    if (this.#ending.has(turnId) || ![...this.#records.values()].some(r => r.turnId === turnId)) return;
    // Drain synchronous frames, their microtasks, and the current transport read before declaring final absence.
    const timer = setImmediate(() => this.#finishEnding(turnId, true));
    this.#ending.set(turnId, { status, timer, drained: false });
  }
  #finishEnding(turnId: string, drained = false): void {
    const ending = this.#ending.get(turnId);
    if (ending === undefined || (!drained && !ending.drained)) return;
    ending.drained = true;
    for (const record of this.#records.values()) {
      if (record.turnId !== turnId || record.final || record.acceptance !== 'accepted') continue;
      if (this.#gaps.has(turnId)) this.uncertain(record.steerId, 'transport_or_protocol_gap');
      else this.#put({ ...record, kind: 'turn_ended_unobserved', turnStatus: ending.status, final: true });
    }
    // Keep the drained marker for replies that arrive after native completion, bounded by retained records.
    clearImmediate(ending.timer);
  }
  close(): void {
    for (const ending of this.#ending.values()) clearImmediate(ending.timer);
    for (const r of this.#records.values()) if (!r.final || r.acceptance === 'pending') this.uncertain(r.steerId, 'session_ended', true);
    this.#records.clear(); this.#seen.clear(); this.#ending.clear(); this.#gaps.clear(); this.#lastLateItem.clear();
  }
  #put(record: SteerRecord): void {
    const frozen = Object.freeze(record);
    this.#records.set(record.steerId, frozen);
    this.publish(frozen);
  }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
