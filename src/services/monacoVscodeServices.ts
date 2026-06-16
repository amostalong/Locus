// Initializes @codingame/monaco-vscode-api services so monaco-languageclient
// can drive monaco like a VSCode editor (hover, completion, diagnostics,
// rename, code actions, semantic tokens, etc.). Idempotent.

import * as monaco from "monaco-editor";
import "vscode/localExtensionHost";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import ExtensionHostWorker from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker";
import TextMateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";

import { initialize as initVscodeServices } from "@codingame/monaco-vscode-api";
import getConfigurationServiceOverride, {
  updateUserConfiguration,
} from "@codingame/monaco-vscode-configuration-service-override";
import getEditorServiceOverride from "@codingame/monaco-vscode-editor-service-override";
import getExtensionsServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFilesServiceOverride from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getMonarchServiceOverride from "@codingame/monaco-vscode-monarch-service-override";
import getTextMateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import { whenReady as themeDefaultsReady } from "@codingame/monaco-vscode-theme-defaults-default-extension";
import { whenReady as csharpDefaultReady } from "@codingame/monaco-vscode-csharp-default-extension";

import { ModelBackedFileSystemProvider, setOpenRoot } from "./editorFileSystemProvider";
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

export function ensureMonacoVscodeServices(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    console.log("[DIAG-MV-0] ensureMonacoVscodeServices START, t=" + Date.now());
    installWorkerEnvironment();
    console.log("[DIAG-MV-1] installWorkerEnvironment done, about to call initVscodeServices");
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
      if (String(e?.message ?? e).includes("already initialized")) {
        console.log("[DIAG-MV-1.5] initVscodeServices threw 'already initialized' — HMR re-entry, continuing");
      } else {
        throw e;
      }
    }
    console.log("[DIAG-MV-2] initVscodeServices RESOLVED, about to await themeDefaultsReady+csharpDefaultReady");
    console.log("[DIAG-MV-2.1] about to call themeDefaultsReady()");
    // theme-defaults-default-extension 33.0.9's whenReady() can hang silently
    // in this Tauri+Vite 6 environment (extension host internal Promise never
    // settles). Letting that block editor init means the rest of Locus is
    // unusable, so we treat the theme extension as fire-and-forget and
    // let the rest of the editor proceed. If the promise does resolve later
    // its then() handler will log success for diagnostics.
    const themeP = themeDefaultsReady();
    themeP.then(() => console.log("[DIAG-MV-2.2] themeDefaultsReady RESOLVED OK")).catch((e) => console.log("[DIAG-MV-2.2] themeDefaultsReady REJECTED", e?.message ?? e));
    console.log("[DIAG-MV-2.3] about to call csharpDefaultReady()");
    const csharpP = csharpDefaultReady();
    csharpP.then(() => console.log("[DIAG-MV-2.4] csharpDefaultReady RESOLVED OK")).catch((e) => console.log("[DIAG-MV-2.4] csharpDefaultReady REJECTED", e?.message ?? e));
    console.log("[DIAG-MV-2.5] awaiting csharpDefaultReady (theme is fire-and-forget)");
    await csharpP;
    console.log("[DIAG-MV-3] csharp extension READY (theme is background)");
    registerUnityLanguages(monaco);
    console.log("[DIAG-MV-4] registerUnityLanguages done, about to applyVscodeColorTheme");
    await applyVscodeColorTheme();
    console.log("[DIAG-MV-5] applyVscodeColorTheme RESOLVED, ensureMonacoVscodeServices DONE");
  })();
  return readyPromise;
}
