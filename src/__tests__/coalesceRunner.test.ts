import { describe, expect, it, vi } from "vitest";
import { createCoalesceRunner } from "../composables/coalesceRunner";

interface FakeScheduler {
  schedule: (callback: () => void) => number;
  cancel: (handle: number) => void;
  flush: () => void;
  pending: number | null;
  callbacks: Map<number, () => void>;
  handleCounter: number;
}

function createFakeScheduler(): FakeScheduler {
  const fake: FakeScheduler = {
    schedule: () => 0,
    cancel: () => {},
    flush: () => {},
    pending: null,
    callbacks: new Map(),
    handleCounter: 0,
  };
  fake.schedule = (callback) => {
    const handle = ++fake.handleCounter;
    fake.callbacks.set(handle, callback);
    fake.pending = handle;
    return handle;
  };
  fake.cancel = (handle) => {
    fake.callbacks.delete(handle);
    if (fake.pending === handle) fake.pending = null;
  };
  fake.flush = () => {
    const handle = fake.pending;
    if (handle === null) return;
    const callback = fake.callbacks.get(handle);
    fake.pending = null;
    fake.callbacks.delete(handle);
    callback?.();
  };
  return fake;
}

describe("createCoalesceRunner", () => {
  it("runs once per frame even with many schedule calls", () => {
    const scheduler = createFakeScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRun,
    });

    runner.schedule("a");
    runner.schedule("b");
    runner.schedule("c");
    runner.schedule("d");

    expect(onRun).not.toHaveBeenCalled();
    expect(scheduler.callbacks.size).toBe(1);

    scheduler.flush();

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(["a", "b", "c", "d"]);
  });

  it("de-duplicates the same reason within a frame", () => {
    const scheduler = createFakeScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRun,
    });

    runner.schedule("streaming-text");
    runner.schedule("streaming-text");
    runner.schedule("streaming-text");

    scheduler.flush();

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(["streaming-text"]);
  });

  it("caps reason buffer to reasonLimit without dropping the first entries", () => {
    const scheduler = createFakeScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRun,
      reasonLimit: 3,
    });

    runner.schedule("a");
    runner.schedule("b");
    runner.schedule("c");
    runner.schedule("d");
    runner.schedule("e");
    runner.schedule("f");

    scheduler.flush();

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toEqual(["a", "b", "c"]);
  });

  it("starts a fresh coalesce window after the previous run fires", () => {
    const scheduler = createFakeScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRun,
    });

    runner.schedule("first-a");
    scheduler.flush();
    runner.schedule("second-a");
    runner.schedule("second-b");
    scheduler.flush();

    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[0]?.[0]).toEqual(["first-a"]);
    expect(onRun.mock.calls[1]?.[0]).toEqual(["second-a", "second-b"]);
  });

  it("cancel prevents the pending run and resets state", () => {
    const scheduler = createFakeScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRun,
    });

    runner.schedule("a");
    runner.schedule("b");
    expect(runner.isPending()).toBe(true);

    runner.cancel();
    expect(runner.isPending()).toBe(false);

    scheduler.flush();
    expect(onRun).not.toHaveBeenCalled();

    // A schedule after cancel starts a clean window.
    runner.schedule("c");
    scheduler.flush();
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(["c"]);
  });

  it("cancel is idempotent when nothing is pending", () => {
    const scheduler = createFakeScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRun,
    });

    runner.cancel();
    runner.cancel();
    expect(runner.isPending()).toBe(false);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("schedule after flush is treated as a new coalesce window", () => {
    const scheduler = createFakeScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRun,
    });

    runner.schedule("frame-1");
    scheduler.flush();

    runner.schedule("frame-2");
    expect(scheduler.callbacks.size).toBe(1);
    scheduler.flush();
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[1]?.[0]).toEqual(["frame-2"]);
  });
});

interface TimedScheduler {
  frame: (callback: () => void) => number;
  timeout: (callback: () => void, delayMs: number) => number;
  cancel: (handle: number) => void;
  flushFrame: () => void;
  flushTimeout: (handle: number) => void;
  callbacks: Map<number, () => void>;
  handleCounter: number;
  pendingTimeouts: Map<number, number>;
}

function createTimedScheduler(): TimedScheduler {
  const state: TimedScheduler = {
    frame: () => 0,
    timeout: () => 0,
    cancel: () => {},
    flushFrame: () => {},
    flushTimeout: () => {},
    callbacks: new Map(),
    handleCounter: 0,
    pendingTimeouts: new Map(),
  };
  state.frame = (callback) => {
    const handle = ++state.handleCounter;
    state.callbacks.set(handle, callback);
    return handle;
  };
  state.timeout = (callback, delayMs) => {
    const handle = ++state.handleCounter;
    state.callbacks.set(handle, callback);
    state.pendingTimeouts.set(handle, delayMs);
    return handle;
  };
  state.cancel = (handle) => {
    state.callbacks.delete(handle);
    state.pendingTimeouts.delete(handle);
  };
  state.flushFrame = () => {
    for (const [handle, callback] of Array.from(state.callbacks.entries())) {
      if (state.pendingTimeouts.has(handle)) continue;
      state.callbacks.delete(handle);
      callback();
    }
  };
  state.flushTimeout = (handle) => {
    const callback = state.callbacks.get(handle);
    if (!callback) return;
    state.callbacks.delete(handle);
    state.pendingTimeouts.delete(handle);
    callback();
  };
  return state;
}

describe("createCoalesceRunner with minIntervalMs", () => {
  it("first run is immediate, subsequent runs are throttled", () => {
    const scheduler = createTimedScheduler();
    const onRun = vi.fn();
    const runner = createCoalesceRunner({
      schedule: scheduler.frame,
      timeout: scheduler.timeout,
      cancel: scheduler.cancel,
      onRun,
      minIntervalMs: 80,
      now: () => 0,
    });

    runner.schedule("first");
    expect(scheduler.callbacks.size).toBe(1);

    // t=0: first run fires.
    scheduler.flushFrame();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("defers schedule calls within the interval after the last flush", () => {
    const scheduler = createTimedScheduler();
    const onRun = vi.fn();
    let nowMs = 0;
    const runner = createCoalesceRunner({
      schedule: scheduler.frame,
      timeout: scheduler.timeout,
      cancel: scheduler.cancel,
      onRun,
      minIntervalMs: 80,
      now: () => nowMs,
    });

    runner.schedule("first");
    scheduler.flushFrame();
    expect(onRun).toHaveBeenCalledTimes(1);

    // t=10: a new schedule arrives 10ms after the last flush. Should be
    // deferred to t=80, not run on the next rAF.
    nowMs = 10;
    runner.schedule("second");
    expect(scheduler.pendingTimeouts.size).toBe(1);

    // t=20: a second schedule within the same interval gets merged into the
    // pending timeout (no new timer).
    nowMs = 20;
    runner.schedule("third");
    expect(scheduler.pendingTimeouts.size).toBe(1);
  });

  it("runs deferred flush at the boundary and resets the throttle window", () => {
    const scheduler = createTimedScheduler();
    const onRun = vi.fn();
    let nowMs = 0;
    const runner = createCoalesceRunner({
      schedule: scheduler.frame,
      timeout: scheduler.timeout,
      cancel: scheduler.cancel,
      onRun,
      minIntervalMs: 80,
      now: () => nowMs,
    });

    runner.schedule("first");
    scheduler.flushFrame();
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]?.[0]).toEqual(["first"]);

    // t=10 → schedule("second") — deferred to t=80.
    nowMs = 10;
    runner.schedule("second");
    // t=20 → schedule("third") — merged with pending.
    nowMs = 20;
    runner.schedule("third");
    expect(scheduler.pendingTimeouts.size).toBe(1);

    // Advance to boundary and fire the timeout.
    nowMs = 80;
    for (const [handle] of scheduler.pendingTimeouts) {
      scheduler.flushTimeout(handle);
    }
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[1]?.[0]).toEqual(["second", "third"]);

    // t=85: a new schedule within the new 80ms window defers again.
    nowMs = 85;
    runner.schedule("fourth");
    expect(scheduler.pendingTimeouts.size).toBe(1);
  });

  it("function-form minIntervalMs picks interval per reason", () => {
    const scheduler = createTimedScheduler();
    const onRun = vi.fn();
    let nowMs = 0;
    const runner = createCoalesceRunner({
      schedule: scheduler.frame,
      timeout: scheduler.timeout,
      cancel: scheduler.cancel,
      onRun,
      minIntervalMs: (reason) => (reason === "user-event" ? 0 : 80),
      now: () => nowMs,
    });

    runner.schedule("streaming-token");
    scheduler.flushFrame();
    expect(onRun).toHaveBeenCalledTimes(1);

    // t=10: a "user-event" reason should run at rAF speed (immediate).
    nowMs = 10;
    runner.schedule("user-event");
    expect(scheduler.pendingTimeouts.size).toBe(0);
    scheduler.flushFrame();
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[1]?.[0]).toEqual(["user-event"]);

    // t=20: a streaming reason within 80ms of the last flush is deferred.
    nowMs = 20;
    runner.schedule("streaming-token");
    expect(scheduler.pendingTimeouts.size).toBe(1);
  });

  it("cancel resets the throttle window so the next schedule is immediate", () => {
    const scheduler = createTimedScheduler();
    const onRun = vi.fn();
    let nowMs = 0;
    const runner = createCoalesceRunner({
      schedule: scheduler.frame,
      timeout: scheduler.timeout,
      cancel: scheduler.cancel,
      onRun,
      minIntervalMs: 80,
      now: () => nowMs,
    });

    runner.schedule("first");
    scheduler.flushFrame();
    expect(onRun).toHaveBeenCalledTimes(1);

    // t=10: schedule then immediately cancel — no run fires.
    nowMs = 10;
    runner.schedule("second");
    runner.cancel();
    expect(scheduler.callbacks.size).toBe(0);
    expect(scheduler.pendingTimeouts.size).toBe(0);

    // t=20: a new schedule after cancel starts a fresh immediate run.
    nowMs = 20;
    runner.schedule("third");
    expect(scheduler.pendingTimeouts.size).toBe(0);
    scheduler.flushFrame();
    expect(onRun).toHaveBeenCalledTimes(2);
  });
});
