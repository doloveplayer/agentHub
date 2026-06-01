# PPTX Workspace Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse `.pptx` agent artifacts directly in the browser from the Files panel.

**Architecture:** Reuse the existing `PptxViewer` component and installed `pptx-preview` package. Add workspace helper functions that distinguish previewable PPTX files from non-previewable binary files, fetch PPTX content through the authenticated workspace download endpoint, render it as a temporary object URL, and keep download fallback available.

**Tech Stack:** React 18, TypeScript, `pptx-preview`, existing workspace REST download API, Playwright.

---

## Tasks

- [ ] Add helper tests for `isPptxWorkspaceFile` and `.pptx` editability semantics.
- [ ] Implement helper changes in `apps/web/src/lib/workspaceFile.ts`.
- [ ] Update `WorkspaceFileEditor` so `.pptx` renders a preview panel instead of the generic binary message.
- [ ] Preserve `.ppt` as non-previewable with download fallback.
- [ ] Run helper tests, Web TypeScript, and Web build.
- [ ] Use Playwright to open a real `.pptx` artifact in the Files panel and verify browser preview UI appears.
- [ ] Commit only related files.
