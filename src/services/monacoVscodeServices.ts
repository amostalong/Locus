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

import { ModelBackedFileSystemProvider } from "./editorFileSystemProvider";
import { registerUnityLanguages } from "./unityLanguages";

let readyPromise: Promise<void> | null = null;

const VSCODE_THEME_DARK = "Default Dark Modern";
const VSCODE_THEME_LIGHT = "Default Light Modern";

function resolveVscodeTheme(): string {
  if (typeof document === "undefined") return VSCODE_THEME_DARK;
  const themeAttr = document.documentElement.getAttribute("data-theme");
  return themeAttr === "light" ? VSCODE_THEME_LIGHT : VSCODE_THEME_DARK;
}

export async function applyVscodeColorTheme(): Promise<void> {
  const theme = resolveVscodeTheme();
  await updateUserConfiguration(JSON.stringify({ "workbench.colorTheme": theme }));
}

function installWorkerEnvironment(): void {
  const env: monaco.Environment = {
    getWorker(_workerId, label) {
      // mlc/monaco-vscode-api spawn workers with these labels. Anything else
      // falls back to the editor worker.
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
    installWorkerEnvironment();
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
    // Wait for default extensions to finish contributing themes / grammars /
    // language configurations. The theme MUST be set after this — seeding
    // workbench.colorTheme before init makes the theme service throw on
    // startup because the contributed themes aren't registered yet.
    await Promise.all([themeDefaultsReady(), csharpDefaultReady()]);
    registerUnityLanguages(monaco);
    // Stand a model-backed provider in front of the default in-memory
    // fs for `file://` URIs. Without this, monaco-vscode-api features
    // that re-read the editor file (wordHighlighter, hover model
    // resolution, peek definition) throw "Unable to read file" and
    // hover cards / definitions silently fail to render.
    registerFileSystemOverlay(1, new ModelBackedFileSystemProvider());
    await applyVscodeColorTheme();
  })();
  return readyPromise;
}
