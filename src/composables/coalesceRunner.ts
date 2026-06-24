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
}

export interface CoalesceRunner {
  /**
   * Mark the runner dirty for this frame with a reason. Subsequent calls
   * within the same frame are merged into the pending run; duplicates of the
   * same reason are de-duplicated.
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
  let handle: number | null = null;
  let dirty = false;
  const reasons: string[] = [];

  function flush() {
    handle = null;
    if (!dirty) return;
    dirty = false;
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
      handle = options.schedule(flush);
    },
    cancel() {
      if (handle === null) return;
      options.cancel(handle);
      handle = null;
      dirty = false;
      reasons.length = 0;
    },
    isPending() {
      return handle !== null;
    },
  };
}
