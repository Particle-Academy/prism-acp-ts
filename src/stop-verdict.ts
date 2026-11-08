import type { StopVerdict } from './process-tree.js';

/** Copy native facts without upgrading an unobserved count to a verified one. */
export function stopVerdictSnapshot(verdict: StopVerdict): StopVerdict {
  return Object.freeze({ graceful: verdict.graceful, empty: verdict.empty, survivors: verdict.survivors, verified: verdict.verified });
}

/** Observation only: a host callback must never change or delay process cleanup. */
export function observeStopVerdict(observer: ((verdict: StopVerdict) => void) | undefined, verdict: StopVerdict): void {
  try {
    // A void callback can still be implemented as async by a host. Do not await it;
    // isolate its rejection as well as a synchronous throw.
    void Promise.resolve(observer?.(verdict)).catch(() => { /* Observation cannot affect native cleanup. */ });
  } catch { /* Observation cannot affect native cleanup. */ }
}
