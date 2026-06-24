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
