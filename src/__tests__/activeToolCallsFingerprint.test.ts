import { describe, expect, it } from "vitest";
import type { ToolCallDisplay } from "../types";
import { buildActiveToolCallsFingerprint } from "../composables/activeToolCallsFingerprint";

function toolCall(partial: Partial<ToolCallDisplay>): ToolCallDisplay {
  return {
    id: partial.id ?? "tc",
    name: partial.name ?? "tool",
    arguments: partial.arguments ?? "{}",
    status: partial.status ?? "running",
    order: partial.order,
    output: partial.output,
    images: partial.images,
    progress: partial.progress,
    nestedToolCalls: partial.nestedToolCalls,
  };
}

describe("buildActiveToolCallsFingerprint", () => {
  it("returns empty string for undefined / empty arrays", () => {
    expect(buildActiveToolCallsFingerprint(undefined)).toBe("");
    expect(buildActiveToolCallsFingerprint([])).toBe("");
  });

  it("encodes length and id/status of each call", () => {
    const fp = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "running" }),
      toolCall({ id: "b", status: "done" }),
    ]);
    expect(fp).toContain("2:");
    expect(fp).toContain("a|running|");
    expect(fp).toContain("b|done|");
  });

  it("changes when a new tool is added", () => {
    const before = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "running" }),
    ]);
    const after = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "running" }),
      toolCall({ id: "b", status: "running" }),
    ]);
    expect(before).not.toBe(after);
  });

  it("changes when a tool's status changes", () => {
    const before = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "running" }),
    ]);
    const after = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "done" }),
    ]);
    expect(before).not.toBe(after);
  });

  it("does NOT change when output / arguments / progress / images mutate", () => {
    // This is the core win: progress ticks (output growing, etc.) should not
    // retrigger the outer-viewport reconcile watch.
    const baseline = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "running", output: "first" }),
    ]);
    const mutated = buildActiveToolCallsFingerprint([
      toolCall({
        id: "a",
        status: "running",
        output: "first line\nsecond line\nthird",
        arguments: '{"deeply":{"changed":true}}',
        progress: { title: "running", info: "50%", progress: 0.5, state: "active" },
        images: [{ id: "img-1", name: "shot.png" }],
      }),
    ]);
    expect(baseline).toBe(mutated);
  });

  it("changes when a nested tool's status changes", () => {
    const before = buildActiveToolCallsFingerprint([
      toolCall({
        id: "a",
        status: "running",
        nestedToolCalls: [toolCall({ id: "n1", status: "running" })],
      }),
    ]);
    const after = buildActiveToolCallsFingerprint([
      toolCall({
        id: "a",
        status: "running",
        nestedToolCalls: [toolCall({ id: "n1", status: "done" })],
      }),
    ]);
    expect(before).not.toBe(after);
  });

  it("does not change when a nested tool's output grows", () => {
    const before = buildActiveToolCallsFingerprint([
      toolCall({
        id: "a",
        status: "running",
        nestedToolCalls: [
          toolCall({ id: "n1", status: "running", output: "short" }),
        ],
      }),
    ]);
    const after = buildActiveToolCallsFingerprint([
      toolCall({
        id: "a",
        status: "running",
        nestedToolCalls: [
          toolCall({
            id: "n1",
            status: "running",
            output: "this output grew by a lot\nwith many lines now",
          }),
        ],
      }),
    ]);
    expect(before).toBe(after);
  });

  it("handles empty nestedToolCalls array without affecting fingerprint", () => {
    const a = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "running", nestedToolCalls: [] }),
    ]);
    const b = buildActiveToolCallsFingerprint([
      toolCall({ id: "a", status: "running" }),
    ]);
    expect(a).toBe(b);
  });

  it("preserves call order in the fingerprint", () => {
    const fp = buildActiveToolCallsFingerprint([
      toolCall({ id: "first", status: "running" }),
      toolCall({ id: "second", status: "running" }),
    ]);
    expect(fp.indexOf("first")).toBeLessThan(fp.indexOf("second"));
  });
});