import type { ToolCallDisplay } from "../types";

/**
 * Build a shallow fingerprint of `activeToolCalls` that captures every change
 * which can affect the outer ChatView viewport layout:
 *   - length (new tool added / removed)
 *   - per-tool `status` (running → done may collapse a tool block)
 *   - nested tool `status` (parent display height depends on nested state)
 *
 * The fingerprint deliberately excludes deep mutations such as `output`,
 * `arguments`, `progress`, and `images`. Those scroll inside the tool block
 * itself; they do not change the outer viewport's scrollHeight and should
 * not trigger a `reconcileViewport()`.
 *
 * The output is a stable string suitable as a `watch` source. Equality
 * comparison is byte-for-byte.
 */
export function buildActiveToolCallsFingerprint(
  calls: ReadonlyArray<ToolCallDisplay> | undefined,
): string {
  if (!calls || calls.length === 0) return "";
  let fingerprint = String(calls.length) + ":";
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    fingerprint += `${call.id}|${call.status}|`;
    const nested = call.nestedToolCalls;
    if (nested && nested.length > 0) {
      for (let j = 0; j < nested.length; j += 1) {
        const n = nested[j]!;
        fingerprint += `${n.id}#${n.status},`;
      }
    }
    fingerprint += ";";
  }
  return fingerprint;
}