# Locus — Agent Notes

Cross-cutting reminders for AI agents working in the Locus codebase. This file is
the canonical (fork-local) entry point; upstream Locus has its own CLAUDE.md at
the repo root, and the workspace fork adds the topics below.

## Window layout convention

独立窗口默认采用标题栏下直接 `header / scroll body / footer` 的连续布局，不
复用 main window 的 split layout。多窗壳由 `ReferenceExternalImportWindow.vue`
和 `ViewHostWindow.vue` 等模板承载；调试独立窗时先去 `App.vue` 的
`isReferenceExternalImportWindowLocation()` / `isChatDiffReviewWindowLocation()`
分叉，再看对应 component。
