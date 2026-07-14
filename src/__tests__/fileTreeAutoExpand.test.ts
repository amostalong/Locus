import { describe, expect, it } from "vitest";
import { deriveAutoExpandPaths } from "../components/editor/fileTreeAutoExpand";

describe("deriveAutoExpandPaths", () => {
  it("returns [] for null", () => {
    expect(deriveAutoExpandPaths(null)).toEqual([]);
  });

  it("returns [] for undefined", () => {
    expect(deriveAutoExpandPaths(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(deriveAutoExpandPaths("")).toEqual([]);
  });

  it("returns [] for a root-level file (no ancestor directory)", () => {
    expect(deriveAutoExpandPaths("Player.cs")).toEqual([]);
  });

  it("returns [] for a single-segment path", () => {
    expect(deriveAutoExpandPaths("README.md")).toEqual([]);
  });

  it("returns all ancestors for a nested file", () => {
    expect(deriveAutoExpandPaths("Assets/Scripts/Player.cs")).toEqual([
      "Assets",
      "Assets/Scripts",
    ]);
  });

  it("handles deep nesting", () => {
    expect(deriveAutoExpandPaths("a/b/c/d/e.txt")).toEqual([
      "a",
      "a/b",
      "a/b/c",
      "a/b/c/d",
    ]);
  });

  it("normalizes Windows-style backslashes to forward slashes", () => {
    expect(deriveAutoExpandPaths("Assets\\Scripts\\Player.cs")).toEqual([
      "Assets",
      "Assets/Scripts",
    ]);
  });

  it("preserves order from shallowest to deepest ancestor", () => {
    const result = deriveAutoExpandPaths("x/y/z/w/q.txt");
    // Index of "x" < index of "x/y" < ...
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startsWith(result[i - 1] + "/")).toBe(true);
    }
  });

  it("ignores leading and trailing slashes", () => {
    // Trailing segment is a file name — not a directory to expand.
    expect(deriveAutoExpandPaths("/Assets/Scripts/Player.cs/")).toEqual([
      "Assets",
      "Assets/Scripts",
    ]);
  });
});
