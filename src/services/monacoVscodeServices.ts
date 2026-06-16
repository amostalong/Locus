// Initializes @codingame/monaco-vscode-api services so monaco-languageclient
// can drive monaco like a VSCode editor (hover, completion, diagnostics,
// rename, code actions, semantic tokens, etc.). Idempotent.

import * as monaco from "monaco-editor";
import "vscode/localExtensionHost";
import {
  getService,
  IWorkbenchThemeService,
} from "@codingame/monaco-vscode-api/services";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import ExtensionHostWorker from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker";
import TextMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";

import { initialize as initVscodeServices } from "@codingame/monaco-vscode-api";
import getConfigurationServiceOverride, {
  updateUserConfiguration,
} from "@codingame/monaco-vscode-configuration-service-override";
import getEditorServiceOverride from "@codingame/monaco-vscode-editor-service-override";
import getExtensionsServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFilesServiceOverride, {
  registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getMonarchServiceOverride from "@codingame/monaco-vscode-monarch-service-override";
import getTextMateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import { whenReady as themeDefaultsReady } from "@codingame/monaco-vscode-theme-defaults-default-extension";
import { whenReady as csharpDefaultReady } from "@codingame/monaco-vscode-csharp-default-extension";

import { ModelBackedFileSystemProvider, setOpenRoot } from "./editorFileSystemProvider";
import { installMonacoErrorHandlers } from "./monacoErrorHandler";
import { registerUnityLanguages } from "./unityLanguages";

let readyPromise: Promise<void> | null = null;

/** Singleton file-system provider so MonacoHost can set its workspace root. */
export const fsProvider = new ModelBackedFileSystemProvider();

/** Also tell openTextDocument the root. */
export function setFsRoot(root: string): void {
  fsProvider.setWorkspaceRoot(root);
  setOpenRoot(root);
}

const VSCODE_THEME_DARK = "Default Dark Modern";
const VSCODE_THEME_LIGHT = "Default Light Modern";

function resolveVscodeTheme(): string {
  if (typeof document === "undefined") return VSCODE_THEME_DARK;
  const themeAttr = document.documentElement.getAttribute("data-theme");
  return themeAttr === "light" ? VSCODE_THEME_LIGHT : VSCODE_THEME_DARK;
}

function peekViewColorCustomizations(isDark: boolean): Record<string, string> {
  if (isDark) {
    // 编辑器背景默认 #1e1e1e，调成 #1d1d1d 微微不一样
    // peek view 用更亮的灰度来区分层次
    return {
      "editor.background": "#1d1d1d",
      "editorGutter.background": "#1d1d1d",
      "peekView.background": "#2d2d2de0",
      "peekView.border": "#569cd673",
      "peekViewTitle.background": "#383838d9",
      "peekViewTitleLabel.foreground": "#e0e0e0f2",
      "peekViewTitleDescription.foreground": "#aaaaaacc",
      "peekViewEditor.background": "#282828d1",
      "peekViewEditorGutter.background": "#282828d1",
      "peekViewResult.background": "#323232d9",
      "peekViewResult.fileForeground": "#ccccccf2",
      "peekViewResult.lineForeground": "#a0a0a0b3",
      "peekViewResult.matchHighlightBackground": "#ffcc0066",
      "peekViewEditor.matchHighlightBackground": "#ffcc0044",
    };
  }
  // light theme
  return {
    "editor.background": "#fafafa",
    "editorGutter.background": "#fafafa",
    "peekView.background": "#e8e8e8d9",
    "peekView.border": "#007acc4d",
    "peekViewTitle.background": "#dcdcdccc",
    "peekViewTitleLabel.foreground": "#333333f2",
    "peekViewTitleDescription.foreground": "#666666cc",
    "peekViewEditor.background": "#f5f5f5cc",
    "peekViewEditorGutter.background": "#f5f5f5cc",
    "peekViewResult.background": "#e0e0e0cc",
    "peekViewResult.fileForeground": "#333333e6",
    "peekViewResult.lineForeground": "#888888b3",
    "peekViewResult.matchHighlightBackground": "#ffcc0066",
    "peekViewEditor.matchHighlightBackground": "#ffcc0044",
  };
}

export async function applyVscodeColorTheme(): Promise<void> {
  const theme = resolveVscodeTheme();
  const isDark = theme === VSCODE_THEME_DARK;
  await updateUserConfiguration(JSON.stringify({
    "workbench.colorTheme": theme,
    "workbench.colorCustomizations": peekViewColorCustomizations(isDark),
  }));
}

function installWorkerEnvironment(): void {
  const env: monaco.Environment = {
    getWorker(_workerId, label) {
      if (label === "editorWorkerService") return new EditorWorker();
      if (label === "extensionHostWorkerMain") return new ExtensionHostWorker();
      if (label === "TextMateWorker") return new TextMateWorker();
      return new EditorWorker();
    },
  };
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = env;
}

// Theme names. The two layers of monaco-vscode-api 33.0.9 use different
// namespaces:
//   - `monaco.editor.setTheme(name)` goes through StandaloneThemeService,
//     which only knows the four built-ins (`vs-dark`, `vs`, `hc-black`,
//     `hc-light`). Anything else falls back to `vs` (LIGHT) — so passing
//     "Default Dark Modern" here would actually turn the editor white.
//   - The workbench theme service (IWorkbenchThemeService.setColorTheme)
//     only recognizes the workbench-flavored ids registered by
//     `@codingame/monaco-vscode-theme-defaults-default-extension`
//     (`Default Dark Modern`, `Default Light Modern`, etc.).
// Both have to be set in lockstep for the editor to look right.
export const VSCODE_THEME_DARK_ID = "Default Dark Modern";
export const VSCODE_THEME_LIGHT_ID = "Default Light Modern";
export const STANDALONE_THEME_DARK = "vs-dark";
export const STANDALONE_THEME_LIGHT = "vs";

type IWorkbenchThemeServiceLike = {
  getColorThemes(): Promise<Array<{ settingsId: string }>>;
  setColorTheme(themeId: string, settingsTarget: unknown): Promise<unknown>;
  onDidColorThemeChange: { (listener: () => void): { dispose(): void } };
  getColorTheme(): { settingsId: string; type: unknown };
};

/**
 * Drive BOTH theme services for the given workbench theme id:
 *   1. `monaco.editor.setTheme("vs-dark"|"vs")` so the standalone editor
 *      has a TokenTheme it can match against (this also seeds the
 *      Monarch token collectors, see comment below).
 *   2. `themeService.setColorTheme(id, undefined)` so the workbench writes
 *      its `.monaco-workbench` CSS variables (editor.background, etc.).
 *
 * Step 2 returns null when the workbench theme registry doesn't yet have
 * the requested id — which is the normal state right after init because
 * `theme-defaults-default-extension`'s activation is asynchronous and the
 * existing fire-and-forget `themeDefaultsReady()` promise can hang in this
 * Tauri+Vite environment. We listen to `onDidColorThemeChange` and retry
 * until the theme lands (or the caller cancels the listener).
 */
function scheduleThemeWhenReady(
  themeService: IWorkbenchThemeServiceLike,
  workbenchId: string,
  standaloneName: string,
): () => void {
  let cancelled = false;
  const applyWorkbench = async (): Promise<boolean> => {
    if (cancelled) return true;
    try {
      const themes = await themeService.getColorThemes();
      if (cancelled) return true;
      if (!themes.some((t) => t.settingsId === workbenchId)) return false;
      await themeService.setColorTheme(workbenchId, undefined);
      return true;
    } catch {
      return false;
    }
  };
  const tryBoth = async (): Promise<boolean> => {
    if (cancelled) return true;
    // Always drive the standalone first — its TokenTheme must be bound
    // before any tokenization pass runs (Monarch race protection).
    monaco.editor.setTheme(standaloneName);
    return applyWorkbench();
  };
  const listener = themeService.onDidColorThemeChange(() => {
    void tryBoth().then((done) => {
      if (done) listener.dispose();
    });
  });
  void tryBoth().then((done) => {
    if (done) listener.dispose();
  });
  return () => {
    cancelled = true;
    listener.dispose();
  };
}

/**
 * Force-apply the current visual theme (dark or light based on
 * `document.documentElement[data-theme]`). Safe to call before
 * `ensureMonacoVscodeServices` — it just no-ops until the workbench
 * theme service is available. Returns a disposable that cancels the
 * retry listener if you no longer need it.
 */
export function ensureVisualTheme(): () => void {
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  const workbenchId = isDark ? VSCODE_THEME_DARK_ID : VSCODE_THEME_LIGHT_ID;
  const standaloneName = isDark ? STANDALONE_THEME_DARK : STANDALONE_THEME_LIGHT;
  // Drive standalone immediately — works even before vscode services init.
  monaco.editor.setTheme(standaloneName);
  let cancel: () => void = () => {};
  void getService(IWorkbenchThemeService)
    .then((svc) => {
      cancel = scheduleThemeWhenReady(svc as IWorkbenchThemeServiceLike, workbenchId, standaloneName);
    })
    .catch(() => {
      // Services not initialized yet — caller will retry via MonacoHost mount.
    });
  return () => cancel();
}

export function ensureMonacoVscodeServices(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    // Install BEFORE initVscodeServices so the handler is in place when
    // Monaco schedules its default setTimeout-throw for caught errors.
    installMonacoErrorHandlers();
    installWorkerEnvironment();
    try {
      await initVscodeServices({
      ...getConfigurationServiceOverride(),
      ...getEditorServiceOverride(async () => undefined),
      ...getExtensionsServiceOverride(),
      ...getFilesServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getModelServiceOverride(),
      ...getMonarchServiceOverride(),
      ...getTextMateServiceOverride(),
      ...getThemeServiceOverride(),
    });
    } catch (e: any) {
      // HMR re-entry: @codingame/monaco-vscode-api is a module-level singleton
      // that throws "Services are already initialized" on the second call.
      // The first call already completed, so services are usable — just
      // continue and let the rest of the init proceed.
      if (!String(e?.message ?? e).includes("already initialized")) {
        throw e;
      }
    }
    // theme-defaults-default-extension 33.0.9's whenReady() can hang silently
    // in this Tauri+Vite 6 environment (extension host internal Promise never
    // settles). Letting that block editor init means the rest of Locus is
    // unusable, so we treat the theme extension as fire-and-forget and let
    // the rest of the editor proceed. `ensureVisualTheme` (called below) and
    // the onDidColorThemeChange listener cover the case where the extension
    // registers late — we re-apply the workbench theme as soon as the
    // registry emits a change event.
    themeDefaultsReady().catch(() => {});
    await csharpDefaultReady();
    // Register our workspace-backed file:// provider as an overlay in front
    // of the default BrowserFileSystemProvider. Without this, Monaco's
    // TextModelResolverService falls back to fetching `file://` URIs via
    // XHR — which CORS-blocks under Tauri+Vite — and the editor ends up
    // with "Unable to resolve nonexistent file" the moment a goto / peek
    // references needs to re-open a model. Priority 1000 puts us in
    // front of the default provider.
    registerFileSystemOverlay(1000, fsProvider);
    // Drive the standalone theme BEFORE the Monarch grammars below register.
    // Monaco's Monarch token collector captures a reference to the active
    // theme at construction; if no theme is active when `setMonarchTokensProvider`
    // runs, the collector's `_theme` field stays undefined and every emit
    // call crashes on `this._theme.match(...)`. The standalone built-ins
    // (`vs-dark` / `vs`) are always registered with the standalone theme
    // service — no extension activation required.
    const isDarkInit = document.documentElement.getAttribute("data-theme") !== "light";
    monaco.editor.setTheme(isDarkInit ? STANDALONE_THEME_DARK : STANDALONE_THEME_LIGHT);
    registerUnityLanguages(monaco);
    await applyVscodeColorTheme();
    // After workbench-side config is set, force-apply the workbench theme
    // via IWorkbenchThemeService. This writes the `.monaco-workbench` CSS
    // variables (editor.background etc.) that determine the actual visual
    // theme — the standalone `setTheme` alone is not enough because in
    // Tauri+Vite the workbench defaults to LIGHT scheme on first paint,
    // which paints the editor white before applyVscodeColorTheme has a
    // chance to react to the config change.
    await ensureVisualTheme();
  })();
  return readyPromise;
}
