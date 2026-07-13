# Locus — Agent Notes

Cross-cutting reminders for AI agents working in the Locus codebase. This file is the canonical
(fork-local) entry point; upstream Locus has its own CLAUDE.md at the repo root, and the
workspace fork adds the topics below.

> **See also**: `Me/merge-plan-v0.5.x.md` for the full audit + decision log of each upstream sync.
> `~/.mavis/agents/mavis/memory/locus-*.md` has detail-level knowledge (monaco gotchas, design
> docs) that this file points to.

## Window layout convention

独立窗口默认采用标题栏下直接 `header / scroll body / footer` 的连续布局，不
复用 main window 的 split layout。多窗壳由 `ReferenceExternalImportWindow.vue`
和 `ViewHostWindow.vue` 等模板承载；调试独立窗时先去 `App.vue` 的
`isReferenceExternalImportWindowLocation()` / `isChatDiffReviewWindowLocation()`
分叉，再看对应 component。

## Upstream sync workflow (v0.5.5+)

**只 sync tagged release** — half-baked upstream commits have broken Unity 6 GUID
compatibility in the past. Tag-only sync = `git fetch upstream --tags` then
`git merge --no-commit --no-ff <tag>`.

### Two-round plan (mandatory before executing)

1. **Round 1 — conflict dry-run**
   - `git diff --name-only <prev-tag>..HEAD` vs `git diff --name-only HEAD..<new-tag>` for
     file intersection count
   - `git merge --no-commit --no-ff <new-tag>` (do the dry-run, then `git merge --abort`)
   - Read the real conflict files; **don't trust `git merge-tree` alone** — it reports 0
     conflicts when actual `git merge` produces 5 (v0.5.6 lesson)

2. **Round 2 — audit + design**
   - `git diff --name-only --diff-filter=D HEAD..<new-tag>` — find what upstream **deletes**
     from your fork (these are usually fork-only files, must be preserved)
   - `git diff --name-only --diff-filter=A HEAD..<new-tag>` — upstream-only adds
   - Grep audit points: `activeTab` naming, `chat.ts` store API, `sessionService` methods,
     package.json fork-only deps, Cargo.toml version pins, language/*.json key adds
   - Identify any **upstream-introduced typecheck bugs** (e.g. v0.5.7 ChatView.vue emit
     signature `[content: string]` not synced with ChatTranscript + chat store's payload)

3. **Execute** — only after user confirms the plan.

### Resolving conflicts

- ChatView / ChatTranscript / chat store: if upstream renamed an API, **follow upstream**;
  update the 12+ fork string literals in one batch with a Python script (precise
  line-targeted replace to avoid hitting `home_dir` / `PYTHONHOME` / `HF_HOME`).
- `skills/view/app/view-runtime/manifest.json` bytes field: pick either ours or theirs
  (don't matter) — `bun run view-runtime:export` will rewrite it.

### Verifying after merge

```bash
bun install        # must show "no changes" (lockfile clean)
bun run typecheck  # must be clean; if it fails, fix the upstream-introduced bug
bun run view-runtime:export  # regenerates view-runtime 4 files
```

## Monaco editor subsystem — fork-only, must preserve

v0.5.7 dropped these as part of its "chat-first, no in-app Monaco" release. **The fork
treats them as core work; never let a merge delete them.**

### Monaco editor components (7)

```
src/components/editor/EditorTabs.vue
src/components/editor/EditorView.vue
src/components/editor/FileTree.vue
src/components/editor/FileTreeNode.vue
src/components/editor/FileTypeIcon.vue
src/components/editor/MonacoHost.vue
src/components/editor/QuickOpenPalette.vue
```

### Monaco + C# LSP composables + services (12)

```
src/composables/coalesceRunner.ts
src/composables/useOmnisharpStatus.ts
src/services/codeRefDetect.ts
src/services/csharpFieldDecoration.ts
src/services/editorFileSystemProvider.ts
src/services/editorFs.ts
src/services/editorLanguage.ts
src/services/editorSync.ts
src/services/layoutDefaults.ts
src/services/monacoVscodeServices.ts
src/services/preprocessorDimming.ts
src/services/unityLanguages.ts
```

### Stores + styles + tests + Rust (4)

```
src/stores/editor.ts
src/styles/monaco-dimming.css
src/__tests__/coalesceRunner.test.ts
src-tauri/src/commands/editor.rs
```

### Dependency pins (fork-only, don't drop)

```
"@codingame/monaco-vscode-api": "~33.0.9"
"@codingame/monaco-vscode-configuration-service-override": "~33.0.9"
"@codingame/monaco-vscode-csharp-default-extension": "~33.0.9"
"@codingame/monaco-vscode-editor-api": "~33.0.9"
"@codingame/monaco-vscode-editor-service-override": "~33.0.9"
"@codingame/monaco-vscode-extensions-service-override": "~33.0.9"
"@codingame/monaco-vscode-files-service-override": "~33.0.9"
"@codingame/monaco-vscode-languages-service-override": "~33.0.9"
"@codingame/monaco-vscode-model-service-override": "~33.0.9"
"@codingame/monaco-vscode-monarch-service-override": "~33.0.9"
"@codingame/monaco-vscode-textmate-service-override": "~33.0.9"
"@codingame/monaco-vscode-theme-defaults-default-extension": "~33.0.9"
"@codingame/monaco-vscode-theme-service-override": "~33.0.9"
"monaco-editor": "npm:@codingame/monaco-vscode-editor-api@~33.0.9"
"monaco-languageclient": "10.7.0"
```

**Upgrade gotcha**: don't upgrade `monaco-vscode-api` to 34+ — known schema break in
`Locus/AGENTS.md` references 33.0.9 as the fork baseline; v0.5.7 doesn't ship these deps
at all (chat-first release).

### Auto-preserve during merge

Git auto-preserves fork-only files during merge without `git checkout --ours` — verify
with `git status` (no `D` lines). v0.5.7 merge: 23 fork-only files all preserved
automatically.

## Unity bridge

Locus has **two pipe systems** for the Unity/Tuanjie connection — diagnose by reading
Tuanjie Console's `[Locus] Bridge started` vs `Native broker bridge active` line.

| Pipe name format | System | Trigger log |
|---|---|---|
| `locus_unity_<sanitized_path>` (e.g. `locus_unity_C__Users_dd_Documents_Foo`) | **OLD managed pipe** (pure C# `NamedPipeServerStream`) | `[Locus] Bridge started, listening on pipe: locus_unity_*` |
| `locus_unity_native_<sha256[:16]>` | **NEW native broker** (Rust DLL `locus_native_plugin`) | `[Locus] Native broker bridge active (generation N).` |

**Tuanjie is Unity renamed, not a separate engine** — the same pipe format works.

**Diagnostic signal**: if Tuanjie Console shows `Bridge started, listening on pipe:
locus_unity_*` → **100% old plugin installed**, not a fork bug. Fork's
`locus_unity/package.json` version 0.1.0 ships the new native broker
(`LocusBridge.cs:594` `NativeStartIfEnabled()`). If the user's Tuanjie project has the
old plugin, they'll see the managed bridge + the desktop app's status icon will turn
red/purple ("Failed to connect to unity") because the Rust side only looks for the
native broker (`unity_bridge/transport.rs:135` `open_client_with_retry` → calls
`get_native_pipe_name` = `project_state_plane_key`).

## View runtime

### `bun run view-runtime:export`

Runs `scripts/export-view-runtime-sources.mjs` which:

1. `rmSync`s the entire `skills/view/app/view-runtime/` directory
2. Re-creates the directory
3. Copies a **fixed list of ~91 source files** to it (view/diff/unity/unity-preview/
   canvas/graph/table/asset/icons/collab/ui/composables/hljs/i18n/services/types)
4. Regenerates `manifest.json` with current `bytes` per file

**Conflict resolution**: when `manifest.json` has merge conflicts, pick either ours or
theirs — export will rewrite it anyway. **Don't bother trying to merge bytes fields.**

**What's NOT in view-runtime**: monaco editor (`src/components/editor/*`), chat
sub-system (`src/components/chat/*`), knowledge chat pane — these are app-side, not
view-runtime. Don't expect export to sync them.

### `scripts/export-view-runtime-sources.mjs` sourceFiles list

Hardcoded array, line 4-101. If upstream adds a new view-runtime renderer (canvas /
graph / table / etc.), you must manually add the path to the array. Check the upstream
release notes for new renderers.

## Locus Unity plugin native DLLs (5 dlls, build artifact)

Upstream `e39bef65 chore(unity): stop tracking self-built editor DLLs` added these to
`.gitignore` (but `.dll.meta` is still tracked for stable Unity GUIDs):

- `locus_unity/Editor/Detour/Locus.Detour.dll`
- `locus_unity/Editor/HotReload/Locus.HotReload.Runtime.dll`
- `locus_unity/Editor/Json/Locus.Json.dll`
- `locus_unity/Editor/Native/x86_64/locus_native.dll`
- `locus_unity/Editor/Roslyn/Locus.Roslyn.dll`

**After any merge that touches C# / Rust source** OR after a v0.5.4+ merge, must run:

```bash
bun run unity:bundle          # 5 serial bundles
bun run compile-server:bundle # LocusCompileServer.dll
```

Then `bun tauri dev`. Skipping this gives:

```
[Locus Unity plugin source is incomplete. Missing required file(s): ...]
```

at startup, blocking the whole app.

### Cargo incremental build silent cache miss

`bun run unity:bundle-native` runs `cargo build --release --manifest-path
locus_native_plugin/Cargo.toml`. If rust src changes don't trigger a cargo rebuild
(`Finished in 0.14s`), the `locus_unity/Editor/Native/x86_64/locus_native.dll`
LastWriteTime is older than the rust commit. **Sanity check**:
`Get-Item .../locus_native.dll | Select LastWriteTime` vs rust commit time. If old,
`python -c "import os; os.utime(path, None)"` to touch the source then rebuild — or
`cargo clean -p locus_native_plugin` to force.

### Verify dll actually contains new symbol

```bash
python -c "import re; data=open(r'.../locus_native.dll','rb').read(); print(
  data.count(b'Unity!IsApplicationActive'), data.count(b'Tuanjie'))"
```

Old fork hardcodes `Unity!IsApplicationActive`; new fork uses bare name + Tuanjie
prefix. `0 + 4` is the correct new shape; non-zero + 0 means old build.

### PowerShell 5.1 `Expand-Archive` doesn't recognize `.nupkg`

`scripts/build-locus-roslyn-bundle.mjs` + `scripts/build-locus-json-bundle.mjs` inline
`Expand-Archive -LiteralPath $nupkg -DestinationPath ...` fails on win32 (ILRepack.exe
can't extract) → `spawnSync ILRepack.exe ENOENT` → unity:bundle cascade-fails. Manual
workaround:

```bash
Copy-Item ilrepack.2.0.44.nupkg ilrepack.zip -Force
Expand-Archive -LiteralPath ilrepack.zip -DestinationPath ilrepack.2.0.44 -Force
```

Apply to all 4 `Locus/.tmp/locus-{roslyn,json,detour,hotreload-runtime}-bundle/`
directories. Root fix: switch those 2 inline `Expand-Archive` segments to the
`extractArchive()` pattern (already used in `build-locus-detour-bundle.mjs`).

## Commit message format

Every commit in `Locus/` (the submodule) **must** include these footers:

```
Design-by: amostalong@126.com
Co-authored-by: deepseek-v4-flash
```

Use `commit-locus.bat "msg"` from the outer repo, or pass them via
`git commit -m 'subject' -m 'Design-by: ...' -m 'Co-authored-by: ...'`.

**PowerShell 5.1 quoting gotcha**: `-m "subject with "quoted" word"` gets tokenized
wrong — PowerShell pairs the wrong quotes and feeds the rest to git as pathspecs (error:
`pathspec 'word' did not match any file`). Fix: use single quotes around `-m` args
`git commit -m 'subject with quoted word' -m 'body' ...` — or write the full message
to `$env:TEMP/msg.txt` and use `git commit -F msg.txt`.

## Active tab naming — fork uses "home" historically

Fork P5 (home mode) routes the upstream "chat" tab through a fork-local "home" top
tab — this is a fork UI concept, not a string rename. **As of v0.5.7 merge, the
internal `activeTab` value has been switched from `"home"` to `"chat"`** to align
with upstream and ease future merges. The `is-home-mode` CSS class and the "home
mode" comments are **preserved** as the fork UI concept name; only the internal
string literal changed.

12 sites changed (file:line, all `home` → `chat`):
- `src/App.vue`: 385, 997, 1003, 1004, 1115
- `src/stores/ui.ts`: 37 (type literal + default), 198, 201
- `src/composables/useAppBootstrap.ts`: 187
- `src/__tests__/uiStore.test.ts`: 166, 236
- `src/__tests__/useAppBootstrap.test.ts`: 155

## Workspace root vs Unity root (P1/P5 design)

Fork split `workspace.path` (user-selected) from `unity_root` (resolved Unity project
root) into two concepts:

- `workspace_root` — top-level user-chosen directory; anchors knowledge / skill / memory
- `unity_root` — resolved Unity project root inside workspace_root; anchors Unity
  integration

~5 weeks of work (P1-P6), in progress as of 2026-07. See
`~/.mavis/agents/mavis/memory/locus-workspace-unity-roots.md` for the design doc + open
issues. **Do not start a v0.5.8+ merge while P1-P6 is in flight** — the data
migration preserves old backups, and the sessions-data orphan is accepted as
collateral.

### P1 / P5 commit history (current state)

| Phase | Commit | Status |
|---|---|---|
| P1 (Workspace struct + `resolve_unity_project_path`) | `8094f8a` | ✅ in develop |
| P2-P6 (knowledge_root 拆分 + data migration) | `2e1d87c` / `0ee7759` / `8aa998c` | ❌ **reverted in `7a52f3d`** |
| P5 精简 (real `set_workspace` body + picker UI) | `8f464f8` | ✅ in develop |
| P6 (delete `set_working_dir` + old data compat) | — | ⏸ not started |

**Why the P2-P6 revert**: the user pushed back — knowledge / skill / memory / sessions /
config.json are all Unity-project-scoped by nature, anchoring them to `workspace_root`
was over-abstraction. Storage root is `unity_root` only; `workspace_root` is purely a
UI concept (picker / recent_dirs / workspace_id fallback).

### Known follow-ups (留尾)

- `set_working_dir` not yet removed (P6) — kept for `working_dir.txt` startup reload back-compat
- `ADR-005` (refuse `workspace_root` falling inside `Assets/`) — not implemented, auto-resolve is the fallback
- Frontend store still single-field `workingDir` (no `workspaceRoot` / `unityRoot` split in `useProjectStore`); 200+ component changes avoided
- Sessions-data orphan after `workspace_root` switch — **accepted**

## Monaco editor architecture — Roslyn ↔ Monaco bridge

Fork runs a custom Roslyn bridge between Monaco (frontend) and a Rust-hosted Roslyn
child process. The bridge is not just "forward JSON-RPC" — five implicit protocols
must be explicitly completed or the editor misbehaves. **If you see Monaco behaving
wrong, first ask "which implicit protocol is broken?"**

| Protocol | Symptom | Fix |
|---|---|---|
| `file://` URI normalization | Monaco sends `file:///c%3A/...` (lowercase + percent-encoded colon); Roslyn uses `file:///C:/...` (uppercase + literal) → "Document is null" | Normalize via `path_to_uri` before forwarding `textDocument/*` |
| `didOpen` missing | MLC auto-fires `textDocument/didOpen`; the fork bridge doesn't → Roslyn has no document | Sniff `params.textDocument.uri` → `uri_to_path` → `LspClient::sync_document` (blake3 dedup) |
| `fsProvider` registration | `ModelBackedFileSystemProvider` must explicitly call `registerFileSystemOverlay(priority, provider)` against monaco-vscode's FileService | Otherwise `TextModelResolverService` falls back to `BrowserFileSystemProvider` → `file://` fetch CORS-blocked → "Unable to resolve nonexistent file" |
| `decompile` temp path outside workspace | Roslyn writes metadata decompile to `%TEMP%\MetadataAsSource\...\Type.cs` | Add `editor_read_file_abs(absolute_path)` IPC, route via abs path when path matches `MetadataAsSource` or `$metadata$` |
| `vscode.commands.executeCommand` race | Returns "Default api is not ready" stub when extension host worker isn't ready | try/catch + fallback to Monaco `IContentWidget` self-render |

**Full detail**: `~/.mavis/agents/mavis/memory/locus-editor-monaco.md`.

### `monaco-vscode-api` 33.0.9 config schema gap (high-priority)

Default `ConfigurationService` schema **does not include** `workbench.colorCustomizations`
/ `editor.tokenColorCustomizations` / `editor.semanticTokenColorCustomizations`. The
downstream consumers (`workbenchThemeService.js:341`'s `onDidChangeConfiguration`
listener, `TokenizationRegistry`, `setCustomSemanticTokenColors`) **still read them**.

Cascade:
1. `updateUserConfiguration()` writes to disk → `configurationEditing.js:614` throws
   `ERROR_UNKNOWN_KEY` → log line `Unable to write to User Settings because X is not a registered configuration`
2. `configService.updateValue()` writes to memory successfully (user value visible via
   `inspect()`), but `configurationProperties[key]` is `undefined`
3. `onDidChangeConfiguration` fires, but listener's `e.affectsConfiguration(key)` returns
   `false` → handler skipped → `setCustomSemanticTokenColors` / `setCustomTokenColors`
   / `setCustomColors` never called → TokenizationRegistry doesn't update → theme
   stylesheet doesn't update

**Fix**: call `configurationRegistry.registerConfiguration({...})` for the three keys
(arbitrary scope, permissive schema, `object` is enough). Idempotent + HMR-safe.
**Must register before `initVscodeServices()`** — `workbenchThemeService` is constructed
during init, listener registers then looks up `configurationProperties`.

**Diagnostic trigger**: see `Unable to write to User Settings because X is not a
registered configuration` in logs → lock this fix immediately. Cross-check
`inspect()` — user value present but `onDidChangeConfiguration` not taking effect is
this bug.

### csharp TextMate grammar limitation (monaco-vscode-api 33.0.9)

The bundled csharp TextMate grammar lumps **all** C# type positions (`void`, `string`,
class name, generic params) into one flat scope `type.cs`. Any TextMate rule with
`scope: "type.cs"` will paint `void` pink too.

**Fix**: abandon TextMate rules for csharp, use only Roslyn LSP semantic tokens.
Roslyn's LSP semantic token treats `void` as `keyword` (default keyword color, not
pink) and `string` / `Player` / `List<>` as `type` (pink). Configure via
`editor.semanticTokenColorCustomizations.rules` with keys `"type"` / `"type.class"` /
`"type.readonly"` — **do NOT add a pink rule for `"keyword"`**, void immediately loses
its distinction.

**Trade-off**: ~500ms after file open, types aren't pink (waiting for Roslyn first
semantic token response). User accepted this — "all pink" is a worse state.

### monaco token rule scope matching (short vs full)

`defineTheme().rules[i].token: "scope.cs"` does **segment-includes** matching on the
TextMate scope chain: `"type.cs"` matches any chain containing a `type` segment
(including `entity.name.type.class.cs`). One rule with `token: "type.cs"` is enough to
hook all type-class tokens — Locus csharp Monarch emits `type.cs`, csharp TextMate
emits `entity.name.type.*.cs`, both pass.

**Reverse doesn't work**: `token: "entity.name.type.class.cs"` does NOT match
`type.cs` (Monarch scope missing entity.name.type.class segments). **Prefer the
shortest matching scope as the primary hook**, keep long chain as safety net.

LSP semantic tokens use a separate token type/modifier channel (not TextMate scope)
— hook via `editor.semanticTokenColorCustomizations.rules` with keys like
`"type"` / `"type.class"` / `"variable.class"`, **which goes through ConfigurationService**
and requires the schema registration above.

### csharp Monarch 500ms fallback limitation

Locus csharp Monarch grammar (fallback, first ~500ms) emits `identifier` for both
**class field** (`_lastScreenHeight`) and **local variable** (`var x = 1;`) — Monarch
regex can't do context-aware distinction.

**Result**: 500ms after open, fields render in default color (mtk1 white). After
TextMate takes over + Roslyn semantic tokens arrive, fields turn indigo and locals
stay default. **User accepted the 500ms delay.**

To根治 the options:
- **Option A**: context-aware Monarch grammar (regex can't — needs PEG/LR, not
  natively supported by monaco)
- **Option B**: Roslyn bridge sends `textDocument/semanticTokens/full` synchronously
  on `didOpen`; editor waits for tokens before render (trade-off: cold-start +500ms+)
- **Option C**: accept the 500ms (current user choice)

### `bun.lock` discipline

Locus submodule tracks `bun.lock` (~600 lines). The outer `QxLocusProject/.gitignore`
excludes `bun.lock` (under "Locus submodule boundaries" block), but **the submodule's
internal tracking is unaffected** — submodule-internal deletion/modification goes
into real commits.

**Discipline**:
- When fixing 0.4.1-era `monaco-vscode-api` 33.0.9 hacks, **do NOT casually `rm
  bun.lock`**
- If you must delete `bun.lock`, do it in a single dedicated commit with explicit
  motivation — never piggyback on a feature commit
- Accidental-deletion recovery: `git checkout HEAD -- bun.lock` (one line, no admin)

## Locus project context

### Product positioning

Locus is the user's **actively-developed** product — a Cursor-for-Unity AI development
tool. Primary Unity project for testing is
`C:\Users\dd\Documents\slg_gameclient\Project` (an SLG game client with heavy
`Microsoft.Unity.Analyzers` C# code).

### Repository layout (recap)

```
QxLocusProject/                  ← outer repo, tracks submodule pointer only
├── Locus/                       ← submodule (amostalong/Locus fork, develop branch)
├── Me/                          ← personal notes + merge plans (this is where you write)
├── start-locus.bat / .ps1       ← launcher (interactive menu)
└── commit-locus.bat             ← commit helper (auto-adds design-by footer)
```

All production code lives in `Locus/`. The outer repo just tracks the submodule HEAD
via pointer commits. See outer `CLAUDE.md` for the launch + commit workflow.

### Stack (0.4.1-era baseline, still in use)

- Vue 3 + Tauri 2 + monaco-editor
- `@codingame/monaco-vscode-api` 33.0.9 (fork baseline; v0.5.7 doesn't ship it at all
  — see "Monaco editor subsystem" above)
- `@codingame/monaco-vscode-csharp-default-extension` 33.0.9

### Diagnostic entry points

- **Tuanjie / Unity console** for C# plugin issues — read the `[Locus] Bridge started
  listening on pipe: locus_unity_*` vs `[Locus] Native broker bridge active` line to
  distinguish old plugin install vs fork bug (see "Unity bridge" above)
- **`locus-console-*.log`** for Monaco / LSP / extension frontend issues — full chain
  is `console.*` → `src/services/debugConsole.ts:captureConsole` →
  `queueForwardToFile` (400ms batch, 128 entries) → `invoke("append_frontend_logs")` →
  `src-tauri/src/commands/log.rs:append_frontend_logs` → `file_sink.enqueue` →
  `locus-console-*.log`. **DevTools console is not enough** — cross-worker threads
  make it incomplete
- **PowerShell visibility**: by default, PowerShell `bun tauri dev` doesn't see
  frontend `app-log` events. To make them visible, the `append_frontend_logs` Rust
  handler must call `tracing::*!` to re-emit. Done in 2026-07-03 (reference
  implementation). **Use `console.log` (not `console.debug`)** for diagnostics —
  `console.debug` is gated by `LOCUS_DEBUG=1` (start-locus.bat option 3) and won't
  show in default `bun tauri dev` output. `console.log` is INFO → `tracing::info!` →
  default-pass. For high-frequency events (e.g. caret move) where 400ms+400ms
  batch-forward latency is too much, use a direct IPC `invoke` instead of `console.log`.
- **Filter noise**: 76 existing `console.log` calls in the frontend are noisy. Add a
  module-name whitelist in `emit_frontend_to_tracing` to filter by prefix
  (`[tab-switch]` / `[chat-stream]` / `[workspace-switch]`)

### Why "monaco-vscode-api 33.0.9" specifically (not "upgrade to 34+")

The 33.0.9 version has **multiple race / not-ready issues** that were individually
worked around in 0.4.1-era work. Upgrade to 34+ likely re-introduces the same class
of bugs with new surface area. **Always prefer workaround (try/catch, fire-and-forget,
direct DOM overlay, `setLanguageConfiguration` after `registerLanguage`) over upgrade**.

Known 33.0.9 bugs that have fork-specific workarounds:
- `"Default api is not ready yet"` race (`vscode.commands.executeCommand` before
  extension host worker is up)
- `defineTheme` throws `"is not a function"` in `IStandaloneThemeService` override
- `ConfiguredStandaloneEditor.addContentWidget` throws `_widgets[getId()]` miss on
  `setWidgetPosition`

**Full detail**: `~/.mavis/agents/mavis/memory/locus-project.md`.
