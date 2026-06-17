/**
 * Preprocessor conditional compilation dimming for Monaco Editor.
 *
 * Parses `#if` / `#elif` / `#else` / `#endif` blocks and returns the
 * line ranges that are *not* active under the current build configuration.
 * Symbols are supplied by the caller (from `getPreprocessorSymbols()` via
 * the Roslyn-backed Rust backend) so the result reflects the *actual*
 * defines in the project rather than guessing.
 */

export interface InactiveRange {
  /** 1-based start line (inclusive) */
  startLine: number;
  /** 1-based end line (inclusive) */
  endLine: number;
}

/** Returns true if the condition evaluates to "active" given the symbol table. */
function evalCondition(cond: string, defined: Set<string>): boolean {
  const s = cond.trim();

  // Explicit inactive / active literals
  if (/^(0|FALSE)\b/i.test(s)) return false;
  if (/^(1|TRUE)\b/i.test(s)) return true;

  // Negation: #if !SYMBOL
  if (s.startsWith("!")) {
    return !evalCondition(s.slice(1), defined);
  }

  // Parenthesised expressions
  if (s.startsWith("(") && s.endsWith(")")) {
    return evalCondition(s.slice(1, -1), defined);
  }

  // Binary operators
  if (s.includes("&&")) {
    const parts = splitBinary(s, "&&");
    return parts.every((p) => evalCondition(p, defined));
  }
  if (s.includes("||")) {
    const parts = splitBinary(s, "||");
    return parts.some((p) => evalCondition(p, defined));
  }

  // Otherwise treat as a symbol reference
  return defined.has(s);
}

function splitBinary(s: string, _op: "&&" | "||"): string[] {
  let depth = 0;
  let last = 0;
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && s.slice(i, i + 2) === "&&") {
      parts.push(s.slice(last, i).trim());
      last = i + 2;
      i++;
    } else if (depth === 0 && s.slice(i, i + 2) === "||") {
      parts.push(s.slice(last, i).trim());
      last = i + 2;
      i++;
    }
  }
  parts.push(s.slice(last).trim());
  return parts.filter((p) => p.length > 0);
}

/** Returns true if the preprocessor directive line is a guard that hides code. */
function isInactiveIfLine(line: string, defined: Set<string>): boolean {
  const m = line.match(/^\s*#\s*(if|elif)\s+(.*)$/);
  if (!m) return false;
  return !evalCondition(m[2], defined);
}

const IF_RE = /^\s*#\s*if\b/;
const ELIF_RE = /^\s*#\s*elif\b/;
const ELSE_RE = /^\s*#\s*else\b/;
const ENDIF_RE = /^\s*#\s*endif\b/;

/**
 * Scans `lines` and returns the ranges of lines that are **not** compiled
 * under the given `defined` symbol set.
 */
export function findInactiveRanges(lines: string[], defined: Set<string>): InactiveRange[] {
  const result: InactiveRange[] = [];

  // Stack entries: { active, startLine }
  // active=true means the current branch compiles; false means it is dimmed.
  const stack: Array<{ active: boolean; startLine: number }> = [
    { active: true, startLine: 0 },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (IF_RE.test(line)) {
      const inactive = isInactiveIfLine(line, defined);
      stack.push({ active: !inactive, startLine: lineNum });
    } else if (ELSE_RE.test(line)) {
      if (stack.length === 0) continue;
      const top = stack[stack.length - 1];
      if (!top.active) {
        // IF/ELIF branch was inactive — emit the just-ended dimmed
        // range *now* (from the original #if/#elif startLine up to
        // but not including this #else line) before flipping the
        // top to active. Without this emit, the if-block's
        // startLine is overwritten below and the dimming is lost.
        result.push({ startLine: top.startLine, endLine: lineNum - 1 });
        top.active = true;
      } else {
        // IF/ELIF was active — the #else branch is inactive. No
        // range emitted here because the just-ended range was
        // active and never tracked. The end-of-block emission
        // below at #endif will handle the rest.
        top.active = false;
      }
      top.startLine = lineNum;
    } else if (ELIF_RE.test(line)) {
      if (stack.length === 0) continue;
      const top = stack[stack.length - 1];
      if (!top.active) {
        // IF/ELIF was inactive — emit the just-ended dimmed range
        // (same reason as the #else branch above), then start a
        // fresh inactive frame for the #elif body. The #elif
        // condition isn't evaluated because the outer branch is
        // already inactive.
        result.push({ startLine: top.startLine, endLine: lineNum - 1 });
        top.active = false;
        top.startLine = lineNum;
      } else {
        // IF/ELIF was active — the #elif is a new conditional
        // branch whose active state is determined by its own
        // condition. The previously-active range was never
        // tracked and stays un-dimmed.
        const inactive = isInactiveIfLine(line, defined);
        top.active = !inactive;
        top.startLine = lineNum;
      }
    } else if (ENDIF_RE.test(line)) {
      if (stack.length <= 1) continue;
      const branch = stack.pop()!;
      if (!branch.active) {
        result.push({ startLine: branch.startLine, endLine: lineNum - 1 });
      }
    }
  }

  return result;
}

/**
 * Convenience wrapper that takes raw source text and a symbol set from
 * the backend (e.g. from `getPreprocessorSymbols()`).
 */
export function findInactiveRangesFromSource(source: string, defined: Set<string>): InactiveRange[] {
  const lines = source.split(/\r?\n/);
  return findInactiveRanges(lines, defined);
}
