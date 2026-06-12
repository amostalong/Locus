/**
 * Layout Defaults Service
 *
 * Allows the user to snapshot their current panel layout (all panel widths,
 * heights, and split ratios stored in localStorage) as a "saved default"
 * that survives resets. On app startup, any unset layout keys are populated
 * from this saved default before components read them.
 */

/** localStorage key under which the saved-defaults snapshot is stored */
export const SAVED_LAYOUT_KEY = "locus:savedLayoutDefaults";

/**
 * All layout-related localStorage keys that affect panel geometry.
 * Only numeric size/ratio keys — excludes toggle/boolean state keys
 * (collapsed, expanded, view mode) and non-layout settings.
 */
export const LAYOUT_KEYS: readonly string[] = [
  "locus-chat-panel-width",
  "locus-editor-sidebar-width",
  "locus:sessionPanelWidth",
  "locus:chatSidebarWidth",
  "locus:chatSidebarHeight",
  "locus:collabSidebarWidth",
  "locus:collabLeftColWidth",
  "locus:collabTerminalHeight",
  "locus:merge-sidebar-w",
  "locus:knowledgePreviewSupportSectionWidth",
  "locus:knowledgePreviewSupportStripHeight",
  "locus:diff:scene-hierarchy-width",
  "locus.collab.stagingSplit.vertical",
  "locus.collab.stagingSplit.horizontal",
  "locus:sessionPanelViewSplitRatio",
];

/**
 * Snapshot the current layout values from localStorage into
 * a saved-defaults blob under `SAVED_LAYOUT_KEY`.
 * Only keys that actually have a value are saved.
 */
export function snapshotCurrentLayout(): void {
  const snapshot: Record<string, string> = {};
  for (const key of LAYOUT_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) {
      snapshot[key] = value;
    }
  }
  localStorage.setItem(SAVED_LAYOUT_KEY, JSON.stringify(snapshot));
}

/**
 * Read the saved-defaults blob.
 * Returns null if none has been saved yet.
 */
export function getSavedLayout(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(SAVED_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Write every saved-default value back to its active localStorage key,
 * overwriting any current value. Then reload the page so that all layout
 * components pick up the restored sizes.
 */
export function restoreSavedLayout(): void {
  const saved = getSavedLayout();
  if (!saved) return;
  for (const [key, value] of Object.entries(saved)) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // skip keys that fail to write
    }
  }
  window.location.reload();
}

/**
 * Returns true if a saved-defaults blob exists.
 */
export function hasSavedLayout(): boolean {
  return localStorage.getItem(SAVED_LAYOUT_KEY) !== null;
}

/**
 * Delete the saved-defaults blob.
 */
export function clearSavedLayout(): void {
  localStorage.removeItem(SAVED_LAYOUT_KEY);
}

/**
 * Populate any layout keys that are currently unset in localStorage
 * from the saved defaults. Called once at app startup so that components
 * whose onMounted fires later will see the saved value rather than the
 * hardcoded factory default.
 */
export function populateSavedLayoutDefaults(): void {
  const saved = getSavedLayout();
  if (!saved) return;
  for (const [key, value] of Object.entries(saved)) {
    if (localStorage.getItem(key) === null) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // skip keys that fail to write
      }
    }
  }
}
