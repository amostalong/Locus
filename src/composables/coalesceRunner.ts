/**
 * Coalesce multiple schedule calls into a single per-frame run.
 *
 * Motivation: chat streaming fires many reactive triggers within a single
 * animation frame (displayedStreamingText flush + activeToolCalls status
 * change + messages.append + pending tool-confirm). Each direct call to the
 * downstream work does its own DOM reads and layout calculations. When chat
 * shares the rAF budget with a heavy right-tab (editor / knowledge), the
 * un-coalesced workload starves the main thread and the whole window stutters.
 *
 * Coalescing collapses N schedule calls within one frame into one downstream
 * run, recording which reasons triggered it for later inspection.
 *
 * For high-frequency trigger sources (e.g. LLM streaming token flushes) an
 * optional `minIntervalMs` further throttles back-to-back runs. The first run
 * always fires immediately; subsequent runs within the window are deferred to
 * the next available slot. The user-visible effect is that the downstream
 * work (viewport reconcile) cannot run more often than the interval even if
 * a new schedule call lands every animation frame, which is what we want
 * when chat is sharing the rAF budget with a heavy neighbor view.
 */

export interface CoalesceScheduleHandle {
  /** Opaque handle returned by `schedule`. Implementations decide the type. */
  id: number;
}

export interface CoalesceRunnerOptions<THandle extends CoalesceScheduleHandle | number> {
  /** Schedule the downstream run; returns an opaque handle. */
  schedule: (callback: () => void) => THandle;
  /** Cancel a previously scheduled handle. */
  cancel: (handle: THandle) => void;
  /**
   * Called when the coalesced run fires. Receives the unique reasons captured
   * since the previous run (de-duplicated, capped at `reasonLimit`).
   */
  onRun: (reasons: string[]) => void;
  /** Maximum number of distinct reasons retained per run. Default 6. */
  reasonLimit?: number;
  /**
   * Minimum wall-clock interval between two consecutive runs. When set,
   * schedule() calls that arrive within the window after the previous run
   * are deferred (via setTimeout) to the next slot. The first run after
   * construction (or after cancel()) is always immediate. Default: no limit.
   *
   * A function form lets callers pick the interval per reason — useful when
   * high-frequency streaming triggers want a 120ms throttle while one-shot
   * user events (tool confirm, question answered) should still run at rAF
   * speed. The function is called once per schedule() that arms a new run.
   */
  minIntervalMs?: number | ((reason: string) => number);
  /**
   * Time source for `minIntervalMs`. Defaults to `performance.now()`. Inject
   * a stub in tests for determinism.
   */
  now?: () => number;
  /**
   * Defer-schedule replacement for tests (analogous to setTimeout). The
   * returned handle is cancelled via the same `cancel` function as frames,
   * so a single `cancel` is enough to abort either kind of handle.
   */
  timeout?: (callback: () => void, delayMs: number) => number;
}

export interface CoalesceRunner {
  /**
   * Mark the runner dirty for this frame with a reason. Subsequent calls
   * within the same window are merged into the pending run; duplicates of
   * the same reason are de-duplicated.
   */
  schedule(reason: string): void;
  /** Cancel any pending run and reset state. Idempotent. */
  cancel(): void;
  /** Whether a run is scheduled for a future frame. */
  isPending(): boolean;
}

/**
 * THandle is constrained to `number` (the common shape of rAF/setTimeout
 * handles) to keep the runner type-safe without forcing callers to wrap.
 */
export function createCoalesceRunner(
  options: CoalesceRunnerOptions<number>,
): CoalesceRunner {
  const reasonLimit = options.reasonLimit ?? 6;
  const minIntervalResolver = options.minIntervalMs ?? 0;
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const scheduleRaw = options.schedule;
  const cancelRaw = options.cancel;
  const timeoutRaw = options.timeout ?? ((cb, delay) => setTimeout(cb, delay) as unknown as number);

  function resolveMinIntervalMs(reason: string) {
    return typeof minIntervalResolver === "function"
      ? minIntervalResolver(reason)
      : minIntervalResolver;
  }

  let handle: number | null = null;
  let handleKind: "frame" | "timeout" | null = null;
  let dirty = false;
  let lastFlushAt = -Infinity;
  const reasons: string[] = [];

  function cancelPending() {
    if (handle === null) return;
    cancelRaw(handle);
    handle = null;
    handleKind = null;
  }

  function arm(delayMs: number) {
    cancelPending();
    if (delayMs <= 0) {
      handleKind = "frame";
      handle = scheduleRaw(flush);
      return;
    }
    handleKind = "timeout";
    handle = timeoutRaw(flush, delayMs);
  }

  function flush() {
    handle = null;
    handleKind = null;
    if (!dirty) return;
    dirty = false;
    lastFlushAt = now();
    const drained = reasons.splice(0, reasons.length);
    options.onRun(drained);
  }

  return {
    schedule(reason: string) {
      if (dirty) {
        if (reasons.length < reasonLimit && !reasons.includes(reason)) {
          reasons.push(reason);
        }
        return;
      }
      dirty = true;
      reasons.push(reason);
      const minInterval = resolveMinIntervalMs(reason);
      if (minInterval <= 0) {
        arm(0);
        return;
      }
      const elapsed = now() - lastFlushAt;
      if (elapsed >= minInterval) {
        arm(0);
        return;
      }
      arm(minInterval - elapsed);
    },
    cancel() {
      cancelPending();
      dirty = false;
      reasons.length = 0;
      // Reset the throttle window so the next schedule is immediate. Callers
      // invoke cancel() to abandon the pending work (e.g. on session switch);
      // a fresh coalesce run for the new context should not be deferred by
      // the previous frame's lastFlushAt.
      lastFlushAt = -Infinity;
    },
    isPending() {
      return handle !== null;
    },
  };
}
