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

import { initialize as initVscodeServices, getService } from "@codingame/monaco-vscode-api";
import { IConfigurationService, IWorkbenchThemeService } from "@codingame/monaco-vscode-api";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import getConfigurationServiceOverride, {
  updateUserConfiguration,
  configurationRegistry,
} from "@codingame/monaco-vscode-configuration-service-override";
import { ConfigurationScope } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configurationRegistry";
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
 * Register the workbench / editor color-customization settings that
 * monaco-vscode-api 33.0.9 omits from its default ConfigurationService
 * schema.
 *
 * ## Why we have to do this ourselves
 *
 * monaco-vscode-api 33.0.9's default schema does NOT include
 * `workbench.colorCustomizations`, `editor.tokenColorCustomizations`, or
 * `editor.semanticTokenColorCustomizations`. These were stripped from
 * the API surface because they're VSCode-workbench concerns that don't
 * strictly belong in a Monaco-only setup — but the downstream consumers
 * (workbenchThemeService, TokenizationRegistry) still read them.
 *
 * Without registration, the chain is broken at three points:
 *
 *   1. `updateUserConfiguration()` (file-write path) throws
 *      `ERROR_UNKNOWN_KEY` — see the [ERROR] "Unable to write to User
 *      Settings because X is not a registered configuration" log line in
 *      `applyVscodeColorTheme`. The validation is in
 *      `configurationEditing.js:614`: `validKeys.indexOf(operation.key) < 0`.
 *
 *   2. `configService.updateValue(key, value, ...)` (in-memory path)
 *      actually succeeds — the value lands in the user cache (visible via
 *      `inspect()`, hence the populated [B] log block). But…
 *
 *   3. `onDidChangeConfiguration` listeners check
 *      `e.affectsConfiguration(key)`, which returns false for any key
 *      not in the `configurationProperties` registry. The
 *      workbenchThemeService's listener
 *      (`browser/workbenchThemeService.js:341`) therefore skips the
 *      `setCustomSemanticTokenColors` / `setCustomTokenColors` /
 *      `setCustomColors` handlers. The customization never reaches
 *      TokenizationRegistry or the theme stylesheet.
 *
 * Registering the keys here populates `configurationProperties`, which
 * makes (1) validation pass, (2) the in-memory write fire a real
 * change event, and (3) `affectsConfiguration` return true — the
 * listener handler runs and the editor's color rules actually take
 * effect.
 *
 * Schemas are intentionally permissive (any object): the consumer
 * (colorThemeData.js `setCustom*Colors`) does its own structural
 * validation. We just need the keys to be *known*.
 *
 * Idempotent: re-registering an already-registered key is a no-op
 * (the registry's `validateProperty` returns an error string, the loop
 * `delete properties[key]` and `continue` — never throws). Safe to
 * run at module top.
 */
function registerLocusColorCustomizations(): void {
  configurationRegistry.registerConfiguration({
    id: "locus.colorCustomizations",
    order: 7,
    title: "Locus workbench / editor color customizations",
    type: "object",
    properties: {
      "workbench.colorCustomizations": {
        type: "object",
        description:
          "Override workbench colors. Required by Locus's pink-overlay scheme and the peekView background tweaks.",
        scope: ConfigurationScope.WINDOW,
        additionalProperties: { type: "string" },
      },
      "editor.tokenColorCustomizations": {
        type: "object",
        description:
          "Override editor token colors. Currently informational — Locus's pink/teal palette is anchored directly via monaco.editor.defineTheme().rules in PINK_TOKEN_RULES, not through this config key.",
        scope: ConfigurationScope.WINDOW,
        additionalProperties: true,
      },
      "editor.semanticTokenColorCustomizations": {
        type: "object",
        description:
          "Override semantic token colors. Drives the Roslyn LSP semantic-token path (the 'orthogonal' confirmation layer over PINK_TOKEN_RULES). Registering this key is what makes the 6a1d9c0 Roslyn-pink scheme actually take effect at runtime.",
        scope: ConfigurationScope.WINDOW,
        additionalProperties: true,
      },
    },
  });
}

// Module-top call: must run before `initVscodeServices()` constructs
// the workbenchThemeService and its onDidChangeConfiguration listener
// (see browser/workbenchThemeService.js:341). HMR re-evaluation
// re-invokes this — safe because the registry skips duplicates.
registerLocusColorCustomizations();

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
      // Default text foreground darkened from the vs-dark base (#D4D4D4)
      // to a mid grey so the csharp-field steel-blue (#93b5cf) stands
      // out — token rules (comments, strings, keywords) are higher
      // priority than editor.foreground and are unaffected, so only
      // uncolored identifiers shift to the dimmer grey.
      "editor.foreground": "#B5B5B5",
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

/**
 * Color overrides that make every C# type identifier stand out as pink.
 *
 * ## Why semantic-tokens only — no textMate rule?
 *
 * monaco-vscode's bundled C# TextMate grammar (from
 * `@codingame/monaco-vscode-csharp-default-extension`) emits a single flat
 * `type.cs` scope for EVERY C# type position, regardless of the underlying
 * construct:
 *
 *   - user-declared class/struct/interface/enum/record/delegate names
 *     (`class Player { ... }` → `Player` is `type.cs`)
 *   - BCL class names (`String`, `Int32`, `Boolean`)
 *   - C# built-in type-keywords (`string`, `int`, `bool`, `byte`, ...)
 *   - generic type arguments (`List<Player>` → both `List` and `Player` are `type.cs`)
 *   - return types (`void Foo()` → `void` is **also** `type.cs`!)
 *
 * The grammar doesn't distinguish `void` from `string` at the textMate layer,
 * so a `textMateRules` entry for `type.cs` would pink `void` along with
 * everything else — that's the bug we just fixed.
 *
 * Roslyn's LSP semantic tokens DO distinguish: `void` is emitted as token
 * type `keyword`, while `string`/`Player`/`List<>` are `type` (with
 * modifiers like `type.class`, `type.readonly`, ...). So we drive the pink
 * purely from the semantic-token layer — `void` falls through to the
 * default `keyword` color (kept by Monaco), and real type identifiers get
 * the pink foreground.
 *
 * Trade-off: files that Roslyn hasn't analysed yet (typically <500ms after
 * open, or very large files mid-analysis) won't show pink on types. We
 * accept this — the previous "everything is pink" state was strictly worse.
 *
 * ## If you want to add textMate rules back later
 *
 * Use the [C2] diagnostic in applyVscodeColorTheme (monaco.editor.tokenize)
 * to dump the actual scopes your grammar emits per token. The previous
 * elaborate `entity.name.type.*.cs` / `keyword.other.type.cs` list was
 * a TextMate-spec assumption (vanilla C# TextMate grammar uses those
 * names), but monaco-vscode's bundled grammar doesn't emit them — keep
 * them as a safety net only if your diagnostic shows them matching.
 */
const CLASS_TYPE_PINK = "#FF69B4"; // hot pink — 在 dark/light 主题上对比度都 OK
const FUNCTION_GREEN = "#9CC9A3"; // muted green — H=130° (greener, less teal), L=0.7, S=0.3
const FIELD_INDIGO = "#5B5BD6"; // 靛青 — class field 专用，与 pink/teal 区分清晰

function classTypeColorCustomizations(): Record<string, unknown> {
  return {
    "editor.semanticTokenColorCustomizations": {
      rules: {
        // Roslyn LSP standard semantic token types.
        type: CLASS_TYPE_PINK,
        // + modifier refinements (Roslyn often emits `type` + modifier,
        // not a single `type.class` token type).
        "type.class": CLASS_TYPE_PINK,
        "type.struct": CLASS_TYPE_PINK,
        "type.interface": CLASS_TYPE_PINK,
        "type.enum": CLASS_TYPE_PINK,
        "type.delegate": CLASS_TYPE_PINK,
        "type.record": CLASS_TYPE_PINK,
        "type.declaration": CLASS_TYPE_PINK,
        "type.readonly": CLASS_TYPE_PINK,
        // Some Roslyn/OmniSharp versions emit a bare `class` token type.
        class: CLASS_TYPE_PINK,
        // Class fields (`_lastScreenHeight`, `m_count`, etc.) — these rules are
        // CURRENTLY DEAD CODE for two compounding reasons:
        //
        //   (1) monaco-vscode-api 33.0.9 has a framework-level bug where
        //       `getEditorFeatures()` (the channel `DocumentSemanticTokensFeature`
        //       registers through) is never invoked by `codeEditorWidget.js:305`
        //       — Monaco never instantiates the contrib that would dispatch
        //       to the provider. So even when `monaco.languages
        //       .registerDocumentSemanticTokensProvider` succeeds, the
        //       provider's `provideDocumentSemanticTokens` is never called.
        //
        //   (2) Even if (1) were fixed, these specific keys (`variable.class`
        //       / `variable.declaration.class`) may not match Roslyn's actual
        //       output — Roslyn does not emit a `class` modifier (LSP RFC 14
        //       standard modifiers are declaration/static/async/readonly/
        //       defaultLibrary/abstract). Roslyn typically emits `property`
        //       + `declaration` for fields (per vscode-csharp historical
        //       behaviour), but we have not verified since the bridge is
        //       blocked by (1).
        //
        // Field coloring today is entirely carried by the Monarch extension
        // in `registerCsharpMonarchFieldGrammar` (unityLanguages.ts file end)
        // — ~80% accuracy on common patterns, no LSP bridge dependency.
        //
        // When (1) is fixed: re-enable the `registerCsharpSemanticTokensProvider`
        // call site in unityLanguages.ts (commented out, four-step procedure
        // documented there). The first dump's tokenType/modifier distribution
        // then tells you which key to use here — replace `variable.class` /
        // `variable.declaration.class` with whatever Roslyn actually emits
        // for fields (likely `property.declaration` or `property.readonly`).
        //
        // We DELIBERATELY do NOT include the bare `variable:declaration`
        // or `variable:readonly` rules that the previous version of this
        // file had — those modifiers also match local variables
        // (`var x = 1;`) and readonly locals, which we want to fall
        // through to Monaco's default identifier color. Only the
        // `class` modifier scopes the rule to class members.
        "variable.class": FIELD_INDIGO,
        "variable.declaration.class": FIELD_INDIGO,
        // Explicitly NOT pinking `keyword` — keeps `void` (and other C#
        // keywords that the grammar mistakenly scopes as type at the
        // textMate layer) at the default Monaco keyword color.
      },
    },
  };
}

/**
 * Pink-overlay Monaco themes — bypass the workbench theme service.
 *
 * ## Why defineTheme + setTheme (and not just configService on tokenColorCustomizations)?
 *
 *   monaco-vscode-api 33.0.9's workbenchThemeService.js listens on
 *   tokenColorCustomizations changes, but the listener is installed only
 *   AFTER extensionService.whenInstalledExtensionsRegistered() resolves.
 *   Our configService.updateValue fires before that, so no listener picks
 *   it up.
 *
 *   Even when the listener is finally installed, it only takes effect
 *   when currentColorTheme is non-empty — and currentColorTheme only
 *   stabilises after workbenchThemeService.initialize(), which never
 *   happens in this branch because getThemeServiceOverride() is removed
 *   (DI key collision with IStandaloneThemeService crashes Monarch).
 *
 *   Workaround: register a custom monaco theme whose rules include our
 *   pink type rule, then setTheme() to it. This bypasses the workbench
 *   layer entirely — the standalone theme service picks up our rules
 *   synchronously.
 *
 * ## Why no `type.cs` token rule here either
 *
 *   Same reason as the user-config textMate rules: monaco-vscode's
 *   bundled csharp grammar emits `type.cs` for `void` too, so a token
 *   rule would pink `void` along with everything else. We intentionally
 *   do NOT pink at the textMate layer here. Pink is driven exclusively
 *   by the Roslyn semantic-token rules in classTypeColorCustomizations().
 *
 *   The broader TextMate-spec scopes below are no-ops against the
 *   current grammar (per the [C2] diagnostic) but kept as a safety net
 *   in case upstream changes the grammar or someone swaps in a richer
 *   csharp TextMate grammar later.
 */
const PINK_THEME_NAME_DARK = "locus-dark-pink";
const PINK_THEME_NAME_LIGHT = "locus-light-pink";

const PINK_TOKEN_RULES = [
  // === Primary hook: Locus csharp Monarch grammar's `type.cs` scope
  //     AND monaco-vscode csharp TextMate grammar's `type.cs` scope.
  //
  // [C2] diagnostic in applyVscodeColorTheme shows that BOTH grammars
  // converge on `type.cs` for type names (Player, string, int, List<>,
  // AOT_Safearea) and BOTH correctly emit `keyword.cs` for `void`
  // (csharp TextMate does this — see [C2] `void Foo...` line). So a
  // single `type.cs` rule here paints type names pink regardless of
  // which grammar is currently active, and `void` falls through to
  // Monaco's default keyword color.
  //
  // This is the load-bearing rule of the whole pink-overlay scheme. The
  // Roslyn LSP semantic-token path (classTypeColorCustomizations) is
  // orthogonal: when it works, it re-confirms what this rule already
  // paints. When it's broken (see `Unable to write to User Settings`
  // ERROR in the [A] block — `editor.semanticTokenColorCustomizations`
  // is not registered in monaco-vscode-api 33.0.9's ConfigurationService
  // schema), this rule still gets the right color out the door.
  { token: "type.cs", foreground: CLASS_TYPE_PINK },
  //
  // === Safety net: longer textMate scope chains. monaco-vscode csharp
  //     TextMate grammar MIGHT emit these on some versions or paths
  //     (it's been known to vary — see commit history pre-[D][E]). They
  //     are no-ops against the current csharp grammar's actual output
  //     (which lands in `type.cs` per the [C2] diagnostic) but kept so
  //     a grammar swap or upstream scope-rename doesn't silently
  //     regress the pink overlay.
  //
  // DO NOT add `type.cs` modifier rules here (e.g. `type.builtin.cs`)
  // unless you verify the [C2] diagnostic shows the grammar emitting
  // them — every additional `type.*.cs` rule that doesn't actually
  // match anything is dead code that misleads the next reader.
  { token: "entity.name.type.class.cs", foreground: CLASS_TYPE_PINK },
  { token: "entity.name.type.struct.cs", foreground: CLASS_TYPE_PINK },
  { token: "entity.name.type.interface.cs", foreground: CLASS_TYPE_PINK },
  { token: "entity.name.type.enum.cs", foreground: CLASS_TYPE_PINK },
  { token: "entity.name.type.delegate.cs", foreground: CLASS_TYPE_PINK },
  { token: "entity.name.type.record.cs", foreground: CLASS_TYPE_PINK },
  { token: "entity.name.type.builtin.cs", foreground: CLASS_TYPE_PINK },
  { token: "support.class.cs", foreground: CLASS_TYPE_PINK },
  { token: "support.type.cs", foreground: CLASS_TYPE_PINK },
  //
  // === Method/function names — distinct from type pink. ===
  //
  // The Locus csharp Monarch grammar emits `identifier.function.cs`
  // for any identifier followed by `(` (unityLanguages.ts:457, with
  // `tokenPostfix: ".cs"`). vs-dark's default tokenTheme does not
  // have a dedicated rule for `identifier.function`, so monaco
  // falls back to mtk1 (the default white) — method calls read as
  // "no syntax highlighting" against the dark background, which is
  // the worst of the four possible states (pink types / teal-green
  // methods / default keyword / default strings is what the user
  // expects from a VSCode-style C# editor).
  //
  // csharp TextMate grammar (when its extension host worker has
  // registered the contribution) typically emits
  // `entity.name.function.cs` for method declarations and
  // `variable.other.object.cs` (or similar) for call sites. We
  // cover both.
  //
  // The bare `identifier.function` / `entity.name.function` rules
  // (no `.cs` suffix) are intentional: they cover Locus's HLSL
  // and ShaderLab Monarch grammars too (both use
  // `identifier.function` for function calls), giving a consistent
  // teal-green across all Locus-language editors. If a future language
  // wants its own function color, it can override at the language
  // level.
  { token: "identifier.function", foreground: FUNCTION_GREEN },
  { token: "entity.name.function", foreground: FUNCTION_GREEN },
  { token: "identifier.function.cs", foreground: FUNCTION_GREEN },
  { token: "entity.name.function.cs", foreground: FUNCTION_GREEN },
  //
  // === Class fields — indigo. ===
  //
  // csharp TextMate grammar (the source of truth once the extension
  // host worker has registered its contribution) emits
  // `variable.other.field.cs` for instance fields and
  // `variable.other.field.private.cs` for private fields (the
  // underscore-prefixed convention `_lastScreenHeight` in this case
  // is just a naming convention — the grammar doesn't care). We
  // paint both indigo so that all class-member state is a single
  // distinct color, separate from pink types and teal methods.
  //
  // Roslyn's semantic-token path covers the same case with the
  // `variable.class` rule in classTypeColorCustomizations() above;
  // the two paths converge on the same indigo.
  //
  // Locus csharp Monarch grammar (the fallback during the ~500ms
  // window before csharp TextMate is ready) does NOT distinguish
  // fields from local variables — both fall through to the
  // `identifier` rule, so fields render as the default white in
  // that window. This is a known Monarch limitation; we don't fix
  // it here because fixing it requires a context-aware grammar
  // (which Monarch regex can't express) or extending the Roslyn
  // bridge to pre-emit field classifications into the Monarch
  // tokenizer. See unityLanguages.ts:457-460 for the Monarch rules.
  { token: "variable.other.field", foreground: FIELD_INDIGO },
  { token: "variable.other.field.cs", foreground: FIELD_INDIGO },
  { token: "variable.other.field.private.cs", foreground: FIELD_INDIGO },
];

function definePinkThemes(): void {
  monaco.editor.defineTheme(PINK_THEME_NAME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: PINK_TOKEN_RULES,
    colors: peekViewColorCustomizations(true),
  });
  monaco.editor.defineTheme(PINK_THEME_NAME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: PINK_TOKEN_RULES,
    colors: peekViewColorCustomizations(false),
  });
}

function pickPinkThemeName(isDark: boolean): string {
  return isDark ? PINK_THEME_NAME_DARK : PINK_THEME_NAME_LIGHT;
}

export async function applyVscodeColorTheme(): Promise<void> {
  const theme = resolveVscodeTheme();
  const isDark = theme === VSCODE_THEME_DARK;

  // === [classTypeColor] [D] Register pink-overlay Monaco themes ===
  // 直接 monaco.editor.defineTheme + setTheme,绕开 workbenchThemeService
  // (本分支已移除 getThemeServiceOverride,原因见下面 NOTE + enforceTokenThemeReady 注释).
  // 这一步只是"先把粉色主题定义/激活好";最终生效由 ensureVisualTheme() 决定
  // (那里是最后调用 monaco.editor.setTheme 的地方,顺序在 applyVscodeColorTheme 之后).
  try {
    definePinkThemes();
    monaco.editor.setTheme(pickPinkThemeName(isDark));
    console.log(
      `[classTypeColor] [D] defined ${PINK_THEME_NAME_DARK} + ${PINK_THEME_NAME_LIGHT}, ` +
      `activated ${pickPinkThemeName(isDark)} (workbench setting: ${theme})`,
    );
  } catch (err) {
    console.error("[classTypeColor] [D] defineTheme/setTheme failed:", err);
  }

  // === [classTypeColor] [E] Hook onDidColorThemeChange (defensive) ===
  // ⚠️ 本分支 workbenchThemeService override 已移除,getService(IWorkbenchThemeService)
  //    通常会 throw — try/catch 兜底,失败也不影响 [D] 路径.
  // 如果将来重新装上 getThemeServiceOverride,这段会自动生效,保住粉色覆盖不被覆盖.
  try {
    const wbThemeService = await getService(IWorkbenchThemeService);
    wbThemeService.onDidColorThemeChange((activeTheme) => {
      const activeId = activeTheme.id;
      const wantName = pickPinkThemeName(isDark);
      // workbench 主题 id 跟 monaco 主题名不同 (例如 "Dark Modern" vs vscode side).
      // 我们在 [E] 检测到 activeId 是 vscode builtin 主题时, 强制 monaco.editor.setTheme 回到我们的粉色覆盖主题.
      if (!activeId.startsWith("locus-")) {
        // 工作区刚切到非粉色主题,马上拉回来
        monaco.editor.setTheme(wantName);
        console.log(
          `[classTypeColor] [E] theme swap detected (${activeId} → ${wantName}), re-applied pink overlay`,
        );
      }
    });
  } catch (err) {
    console.error("[classTypeColor] [E] theme change hook failed (expected when workbenchThemeService override is removed):", err);
  }

  // NOTE: main 分支 has the workbench theme service override removed (DI key
  // collision with IStandaloneThemeService crashes the Monarch tokenizer).
  // Pushing `workbench.colorTheme` here triggers a listener that calls
  // monaco.editor.setTheme("Default Dark Modern") — without the workbench
  // theme service, this falls back to "vs" (LIGHT) and breaks the color map.
  // We therefore OMIT `workbench.colorTheme` from the config push.
  // The other keys (workbench.colorCustomizations, editor.tokenColorCustomizations,
  // editor.semanticTokenColorCustomizations) are safe to push and the tokenizer
  // / semantic-token provider reads them regardless of the workbench theme service.
  const customization = {
    "workbench.colorCustomizations": peekViewColorCustomizations(isDark),
    ...classTypeColorCustomizations(),
  };

  // === [classTypeColor] [A] Dump the JSON we are about to push to ConfigurationService ===
  console.log(
    "[classTypeColor] [A] pushing customization JSON:\n" +
      JSON.stringify(customization, null, 2),
  );

  // [A1] Try updateUserConfiguration first (raw file write — used for persistence).
  // This DOES NOT update the live in-memory ConfigurationService cache, so by
  // itself it's not enough. The next call (configService.updateValue) is what
  // actually makes the change take effect at runtime.
  await updateUserConfiguration(JSON.stringify(customization));

  // [A2] The proper way to make a configuration change visible to the live
  // tokenizer / theme service / semantic-token provider is to call
  // `IConfigurationService.updateValue(key, value, ConfigurationTarget.USER)`
  // directly. This:
  //   1. updates the in-memory configuration cache
  //   2. persists to settings.json (same as updateUserConfiguration)
  //   3. fires `onDidChangeConfiguration` — listeners (theme service,
  //      tokenization registry, semantic-token provider) all re-read
  //
  // updateUserConfiguration ALONE is NOT sufficient in monaco-vscode-api
  // 33.0.9's browser ConfigurationService: it writes the file but never
  // notifies the live service to re-read, so inspect() returns undefined
  // for the pushed keys and no consumer ever sees the change. (The
  // file-write ALSO used to fail with `ERROR_UNKNOWN_KEY` for
  // `editor.semanticTokenColorCustomizations` and friends, until we
  // started registering those keys in `registerLocusColorCustomizations`
  // at module top — see the long comment there for the chain.)
  try {
    const configService = await getService(IConfigurationService);
    for (const [key, value] of Object.entries(customization)) {
      await configService.updateValue(key, value, ConfigurationTarget.USER);
    }
    console.log(
      `[classTypeColor] [A2] configService.updateValue × ${Object.keys(customization).length} key(s) → ConfigurationTarget.USER`
    );
  } catch (err) {
    console.error("[classTypeColor] [A2] configService.updateValue failed:", err);
  }

  // === [classTypeColor] [B] Inspect ConfigurationService to confirm we actually stored it ===
  // inspect() returns a class instance with getter properties (user, userLocal,
  // application, default, memory, ...). The getters are NON-ENUMERABLE, so
  // `JSON.stringify(inspectResult)` returns "{}" — that's what we saw in the
  // first diagnostic pass and it was misleading. We must explicitly invoke
  // each getter, then stringify the resolved values.
  //
  // What we're looking for:
  //   - `user` or `userLocal` non-undefined  → ConfigurationService accepted
  //     the key (it routed our updateUserConfiguration() push through)
  //   - both undefined                       → ConfigurationService dropped
  //     it (schema doesn't recognize the key, override filter rejected it, ...)
  function formatInspect(label: string, insp: unknown): string {
    if (insp === null || insp === undefined) {
      return `${label}=<null/undefined>`;
    }
    // Resolve each well-known section by direct property access — this
    // invokes the getter, returning the current value. We do NOT rely on
    // JSON.stringify enumerating the inspect object's own keys.
    const obj = insp as {
      user?: unknown;
      userLocal?: unknown;
      application?: unknown;
      workspace?: unknown;
      default?: unknown;
      memory?: unknown;
    };
    const sections = ["user", "userLocal", "application", "workspace", "default", "memory"];
    const parts: string[] = [];
    for (const sec of sections) {
      const v = obj[sec as keyof typeof obj];
      if (v === undefined) {
        parts.push(`  ${sec.padEnd(11)}=<undefined>`);
      } else {
        let rendered: string;
        try {
          rendered = JSON.stringify(v, null, 2);
        } catch (e) {
          rendered = `<unstringifiable: ${String(e)}>`;
        }
        // Indent each line of the rendered value for legibility
        rendered = rendered.replace(/\n/g, "\n              ");
        parts.push(`  ${sec.padEnd(11)}=${rendered}`);
      }
    }
    return `${label}:\n${parts.join("\n")}`;
  }
  try {
    const configService = await getService(IConfigurationService);
    const tccInspect = configService.inspect<unknown>(
      "editor.tokenColorCustomizations",
    );
    const stccInspect = configService.inspect<unknown>(
      "editor.semanticTokenColorCustomizations",
    );
    console.log(`[classTypeColor] [B] ${formatInspect("editor.tokenColorCustomizations", tccInspect)}`);
    console.log(`[classTypeColor] [B] ${formatInspect("editor.semanticTokenColorCustomizations", stccInspect)}`);
  } catch (err) {
    console.error("[classTypeColor] [B] ConfigurationService inspect failed:", err);
  }

  // === [classTypeColor] [C] Tokenize a sample C# program and dump:
  //   [C2] tokenize() Token[][] → every token's monaco token type (verify grammar scope names)
  //   [C1] colorize() HTML       → every token's actual rendered color (verify the tokenColors chain end-to-end)
  // Key thing to look at: token `string` / `Player` / `List<Player>`'s type
  // string + rendered color.
  const sampleLines = [
    "class Player { void Foo(string s, List<Player> p) { var x = 1; } }",
    'string s = "hello";',
    "int n = 1;",
    "AOT_Safearea foo;",
    // Field-coloring diagnostic — verify what scope csharp TextMate
    // actually emits for `_lastScreenHeight` so we know whether the
    // `variable.other.field.cs` token rule below is the right hook.
    "private int _lastScreenHeight;",
    "private static readonly int MaxCount = 32;",
  ];

  // [C2] tokenize: see what the grammar actually gives us for token types
  try {
    for (const line of sampleLines) {
      const tokens = monaco.editor.tokenize(line, "csharp");
      console.log(`[classTypeColor] [C2] tokenize("${line}"):`);
      for (const lineTokens of tokens) {
        for (const t of lineTokens) {
          const slice = line.substring(t.offset);
          console.log(
            `  offset=${t.offset.toString().padStart(3, " ")} type=${(t.type ?? "?").padEnd(40, " ")} text="${slice}"`,
          );
        }
      }
    }
  } catch (err) {
    console.error("[classTypeColor] [C2] monaco.editor.tokenize failed:", err);
  }

  // [C1] colorize: see the actual rendered color per token (the final verdict
  // on whether the tokenColors chain works)
  try {
    for (const line of sampleLines) {
      const html = await monaco.editor.colorize(line, "csharp", { tabSize: 2 });
      console.log(`[classTypeColor] [C1] colorize("${line}"):\n${html}`);
    }
  } catch (err) {
    console.error("[classTypeColor] [C1] monaco.editor.colorize failed:", err);
  }

  // [C3] THE GROUND TRUTH: actually mount a <span class="mtk22"> in the DOM
  // and read getComputedStyle(...).color. This tells us what the user ACTUALLY
  // sees, not what monaco's colorize() string-reports. Critical for diagnosing
  // whether `editor.tokenColorCustomizations` textMateRules are reaching the
  // CSS that the browser applies. If `mtk22` is not pink here, the rule
  // never made it into the theme's stylesheet.
  try {
    const probe = document.createElement("div");
    probe.id = "locus-mtk22-probe";
    probe.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;";
    probe.innerHTML = `<span class="mtk22">Player</span>`;
    document.body.appendChild(probe);
    const span = probe.querySelector(".mtk22") as HTMLElement;
    const computed = window.getComputedStyle(span);
    const fg = computed.color;
    const fontStyle = computed.fontStyle;
    // Also enumerate all CSS rules in the document that mention mtk22 to see
    // if our textMateRules rule was injected with our #FF69B4 foreground.
    const matchingRules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules ?? [])) {
          const text = (rule as CSSRule).cssText ?? "";
          if (text.includes("mtk22")) {
            matchingRules.push(text);
          }
        }
      } catch {
        // Cross-origin sheet — skip
      }
    }
    console.log(
      `[classTypeColor] [C3] DOM ground truth for <span class="mtk22">: ` +
        `color=${fg} fontStyle=${fontStyle}`,
    );
    console.log(
      `[classTypeColor] [C3] matching CSS rules (${matchingRules.length}):\n` +
        matchingRules.slice(0, 20).join("\n"),
    );
    document.body.removeChild(probe);
  } catch (err) {
    console.error("[classTypeColor] [C3] DOM probe failed:", err);
  }

  console.log("[classTypeColor] diagnostic complete");
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
  // === [classTypeColor] [D-final] Define pink-overlay themes BEFORE the safety dance ===
  // 必须先 define,后面的 enforceTokenThemeReady 通过 getColorTheme 验证时
  // 才会看到 pink theme (而不是先看到 locus-stable-theme).
  try {
    definePinkThemes();
  } catch (e) {
    console.warn("[monaco] definePinkThemes skipped, falling back to standalone:", e);
    monaco.editor.setTheme(standaloneName);
  }
  // Drive standalone immediately — works even before vscode services init.
  // 注意:enforceTokenThemeReady 内部会 setTheme 到 locus-stable-theme;
  // 我们在它之后会用 setTheme(pinkName) 覆盖回来 — 粉色主题才是最终生效的 active theme.
  monaco.editor.setTheme(standaloneName);
  // Also force the standalone theme service's TokenTheme to be constructed
  // synchronously. In monaco-vscode-api 33.0.9, when TokenTheme is not yet
  // lazily constructed, MonarchModernTokensCollector crashes on
  // `this._theme.match(...)` because tokenTheme is undefined.
  enforceTokenThemeReady(isDark);
  // === [classTypeColor] [D-final] Activate pink theme as the LAST setTheme call ===
  // enforceTokenThemeReady 内部 setTheme 到 locus-stable-theme(只是为了让
  // getColorTheme().tokenTheme 非空);这里强制覆盖到 pink,保证编辑器看到的是粉色覆盖.
  monaco.editor.setTheme(pickPinkThemeName(isDark));
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
    // tracker. We therefore call applyVscodeColorTheme() but the function
    // itself OMITS `workbench.colorTheme` from the push — only the
    // editor.tokenColorCustomizations / editor.semanticTokenColorCustomizations
    // (read by the tokenizer / semantic-token provider, NOT by the workbench
    // theme service) and the peekView workbench.colorCustomizations (a no-op
    // without the workbench theme service) are written. Safe to call.
    await applyVscodeColorTheme();
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
