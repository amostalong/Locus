// Initializes @codingame/monaco-vscode-api services so monaco-languageclient
// can drive monaco like a VSCode editor (hover, completion, diagnostics,
// rename, code actions, semantic tokens, etc.). Idempotent.

import * as monaco from "monaco-editor";
import "vscode/localExtensionHost";
import {
  StandaloneServices,
} from "@codingame/monaco-vscode-api/services";
import {
  setUnexpectedErrorHandler,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/errors";

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
import { whenReady as themeDefaultsReady } from "@codingame/monaco-vscode-theme-defaults-default-extension";
import { whenReady as csharpDefaultReady } from "@codingame/monaco-vscode-csharp-default-extension";
import { IStandaloneThemeService } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/common/standaloneTheme.service";
import { TokenizationRegistry } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/languages";

import { ModelBackedFileSystemProvider, setOpenRoot } from "./editorFileSystemProvider";
import { registerUnityLanguages } from "./unityLanguages";

let readyPromise: Promise<void> | null = null;
let errorHandlerInstalled = false;

/**
 * Install a silent error handler for Monaco internal crashes.
 * Without this, the Monarch tokenizer's `_theme.match(…)` crash
 * (`Cannot read properties of undefined (reading 'match')`) propagates
 * as an unhandled error and floods the console. We downgrade it to a
 * warning so the editor stays functional even when the tokenizer can't
 * resolve a theme.
 *
 * Only installed once; safe to call multiple times.
 */
function installMonacoErrorHandler(): void {
  if (errorHandlerInstalled) return;
  errorHandlerInstalled = true;
  setUnexpectedErrorHandler((err: unknown) => {
    const msg = String(err?.toString?.() ?? err);
    // Known benign Monaco internal errors that should not crash the editor:
    //   - Monarch race / missing token theme: MonarchModernTokensCollector.emit
    //     crashes when this._theme.match() sees undefined tokenTheme
    //   - Default api not ready yet: extension host worker fires before
    //     the vscode API lands on the main thread
    //   - getRelativeLuminance: MinimapTokensColorTracker reads a color-map
    //     entry that hasn't been populated yet (race between theme service
    //     populating TokenizationRegistry and ViewModel construction)
    //   - reading 'emitsOptions': Vue component update race triggered when
    //     the editor crashes and leaves the component tree in a bad state
    if (
      msg.includes("reading 'match'") ||
      msg.includes("Default api is not ready yet") ||
      msg.includes("monarch") ||
      msg.includes("getRelativeLuminance") ||
      msg.includes("emitsOptions")
    ) {
      console.warn("[monaco:silenced]", msg);
      return;
    }
    // Let everything else through normally
    console.error("[monaco]", msg);
  });
}

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

export const STANDALONE_THEME_DARK = "vs-dark";
export const STANDALONE_THEME_LIGHT = "vs";

// NOTE: we intentionally do NOT include getThemeServiceOverride() in the
// initVscodeServices call below, because IStandaloneThemeService and
// IThemeService both register with createDecorator("themeService") — they
// share the same DI key. Including the theme override would replace the
// StandaloneThemeService with StandaloneWorkbenchThemeService for BOTH,
// which leaves the Monarch tokenizers without a valid TokenTheme and
// crashes on this._theme.match(...).

/**
 * Inject a <style> element with editor background color. This bridges the
 * gap between the standalone theme service setting the TokenTheme and the
 * workbench theme service writing its CSS variables — which is async and can
 * take hundreds of ms (or hang indefinitely) in monaco-vscode-api 33.0.9's
 * extension host. Without this, the editor renders with a white background
 * between init and the workbench theme applying.
 */
function installEditorBackgroundFallback(isDark: boolean): void {
  const id = "locus-editor-bg-fallback";
  if (document.getElementById(id)) return;
  const bg = isDark ? "#1e1e1e" : "#ffffff";
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `.monaco-editor, .monaco-editor .margin { background: ${bg} !important; }`;
  document.head.appendChild(style);
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
  const standaloneName = isDark ? STANDALONE_THEME_DARK : STANDALONE_THEME_LIGHT;
  // Drive standalone immediately — works even before vscode services init.
  monaco.editor.setTheme(standaloneName);
  // Also force the standalone theme service's TokenTheme to be constructed
  // synchronously. In monaco-vscode-api 33.0.9, when TokenTheme is not yet
  // lazily constructed, MonarchModernTokensCollector crashes on
  // `this._theme.match(...)` because tokenTheme is undefined.
  enforceTokenThemeReady(isDark);
  // Inject a CSS fallback for the editor background. Without the theme
  // service override (see NOTE above), the standalone theme service
  // manages CSS variables synchronously, but the fallback ensures the
  // editor never flashes white during init.
  installEditorBackgroundFallback(isDark);
  return () => {};
}

/**
 * Force the TokenizationRegistry's color-map to match the current theme's
 * TokenTheme color-map.  MinimapTokensColorTracker (created synchronously
 * inside every ViewModel constructor) reads `colorMap[ColorId.DefaultBackground]
 * .getRelativeLuminance()` and crashes if the array is truncated or stale.
 *
 * Call this immediately before `editor.setModel()` to guarantee the registry
 * is in sync with the active theme.
 */
export function ensureColorMapReady(): void {
  try {
    const themeService = StandaloneServices.get(IStandaloneThemeService);
    const theme = themeService.getColorTheme();
    if (!theme?.tokenTheme) return;

    const authoritative = theme.tokenTheme.getColorMap();
    if (!authoritative || authoritative.length < 3) return;

    const reg = TokenizationRegistry.getColorMap();
    // Fast path: registry already has a valid DefaultBackground.
    if (reg && reg.length >= 3 && reg[2] != null) return;

    // _updateThemeOrColorMap → TokenizationRegistry.setColorMap doesn't
    // reliably propagate the authoritative map (the function may throw
    // during CSS generation before reaching setColorMap).  Bypass it.
    TokenizationRegistry.setColorMap(authoritative);
  } catch (e) {
    console.warn("[monaco] ensureColorMapReady skipped:", e);
  }
}

/**
 * Define and activate a custom (non-builtin) standalone theme so that the
 * Monarch tokenizer always sees a valid TokenTheme.
 *
 * ## Why this is necessary
 *
 * In monaco-vscode-api 33.0.9, `StandaloneThemeService.defineTheme` calls
 * `notifyBaseUpdated()` on every theme whose base is the (builtin) name
 * being defined. That method sets `_tokenTheme = null`, which means the
 * next Monarch tokenization pass that reads
 * `this._standaloneThemeService.getColorTheme().tokenTheme` gets
 * `undefined` — and `MonarchModernTokensCollector.emit()` crashes on
 * `this._theme.match(...)` (`Cannot read properties of undefined`).
 *
 * A custom theme name (not `vs`, `vs-dark`, `hc-black` or `hc-light`) is
 * **never** the argument to `notifyBaseUpdated`, so its `_tokenTheme` is
 * never spuriously cleared after construction.
 */
function enforceTokenThemeReady(isDark: boolean): void {
  try {
    const themeService = StandaloneServices.get(IStandaloneThemeService);
    const base = isDark ? STANDALONE_THEME_DARK : STANDALONE_THEME_LIGHT;
    // Always define a custom theme so it is not subject to `notifyBaseUpdated`.
    monaco.editor.defineTheme("locus-stable-theme", {
      base,
      inherit: true,
      rules: [],
      colors: {},
    });
    monaco.editor.setTheme("locus-stable-theme");
    // Force TokenTheme construction and verify it's usable.
    const theme = themeService.getColorTheme();
    if (!theme || !theme.tokenTheme) {
      console.error("[monaco] CRITICAL: tokenTheme undefined after defineTheme fallback");
    }
    // TokenTheme & color map confirmed valid; see ensureColorMapReady for
    // the authoritative push to TokenizationRegistry.
  } catch (e) {
    // Services not initialised yet — caller retries via MonacoHost mount.
    console.warn("[monaco] enforceTokenThemeReady skipped:", e);
  }
}

export function ensureMonacoVscodeServices(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    installMonacoErrorHandler();
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
    // in this Tauri+Vite 6 environment. Fire-and-forget — the extension is
    // not needed since we do NOT use the theme service override (see NOTE
    // about the DI key collision above).
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
    // Verify the TokenTheme is constructed — MonarchModernTokensCollector.emit
    // crashes if tokenTheme is still undefined when registerUnityLanguages
    // triggers setMonarchTokensProvider.
    enforceTokenThemeReady(isDarkInit);
    registerUnityLanguages(monaco);
    // applyVscodeColorTheme writes "workbench.colorTheme": "Default Dark Modern"
    // to user config. Without the theme service override (removed due to DI key
    // collision), this workbench theme name can't be resolved by the standalone
    // theme service. If any listener reacts to the config change and calls
    // monaco.editor.setTheme("Default Dark Modern"), the standalone service
    // falls back to "vs" (LIGHT), breaking the color map and Monet's minimap
    // tracker. We skip this call — the standalone theme + background CSS
    // fallback provide adequate styling. Color customizations (peekView, etc.)
    // are applied via the background fallback CSS instead.
    // await applyVscodeColorTheme();
    // Apply the standalone theme and editor background CSS fallback.
    // NOTE: we intentionally do NOT use the workbench theme service
    // (getThemeServiceOverride) because it shares the same DI key as
    // IStandaloneThemeService, which breaks the Monarch tokenizer's
    // TokenTheme. See the NOTE above enforceTokenThemeReady.
    await ensureVisualTheme();
    // Verify the color map is complete – MinimapTokensColorTracker
    // (constructed when the first ViewModel is created) reads it.
    ensureColorMapReady();
  })();
  return readyPromise;
}
