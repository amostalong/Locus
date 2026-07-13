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
