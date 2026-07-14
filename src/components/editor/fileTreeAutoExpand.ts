/**
 * Derive the list of ancestor directory paths that should be auto-expanded
 * to reveal `activePath` in the FileTree.
 *
 * The returned list is in order from shallowest to deepest ancestor. A
 * matching ancestor entry will pass `entry.relPath === path` against
 * `FileTreeNode`'s entry, so paths are normalized to forward slashes.
 *
 * Examples:
 *   "Assets/Scripts/Player.cs" → ["Assets", "Assets/Scripts"]
 *   "Player.cs"                → []
 *   "a/b/c/d/e.txt"            → ["a", "a/b", "a/b/c", "a/b/c/d"]
 *   null / "" / undefined      → []
 */
export function deriveAutoExpandPaths(
  activePath: string | null | undefined,
): string[] {
  if (!activePath) return [];
  const normalized = activePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  // A root-level file (or a bare filename) has no ancestor directory
  // that needs expanding.
  if (parts.length <= 1) return [];
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i).join("/"));
  }
  return ancestors;
}
