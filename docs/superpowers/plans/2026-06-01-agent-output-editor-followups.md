# Agent Output Editor Followups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add folder download, a larger fullscreen editing experience, and clear handling for non-text artifacts such as PPT files.

**Architecture:** Add a backend ZIP archive helper and download endpoint for workspace files/directories. Extend the existing Files tab so folders have a download action and files can be double-clicked into a centered fullscreen Monaco editor. Keep PPT files downloadable but not editable as structured slides because the current workspace editor is text-based and PowerPoint files are binary OOXML packages.

**Tech Stack:** Hono, Node `fs`/`path`, custom ZIP buffer writer, React 18, Monaco, Playwright, TypeScript node:test.

---

## File Structure

### Create

- `apps/api/src/routes/workspaceArchive.test.ts`: Unit tests for ZIP archive generation and path confinement.
- `apps/api/src/routes/workspaceArchive.ts`: Workspace archive collection and ZIP buffer writer.

### Modify

- `apps/api/src/routes/workspace.ts`: Add `GET /api/workspace/:sessionId/download?path=...`.
- `apps/web/src/lib/api.ts`: Add `downloadWorkspacePath(sessionId, path)`.
- `apps/web/src/lib/workspaceFile.ts`: Add text-editability and folder ZIP naming helpers.
- `apps/web/src/lib/workspaceFile.test.ts`: Cover PPT/non-text behavior and ZIP download names.
- `apps/web/src/components/FileTree.tsx`: Add folder/file download button and double-click open callback.
- `apps/web/src/components/WorkspaceFileEditor.tsx`: Add fullscreen sizing, maximize/minimize action, and non-text artifact message.
- `apps/web/src/components/AgentStatusPanel.tsx`: Manage selected file and fullscreen editor state.

## Task 1: Backend ZIP Archive Helper

- [ ] Write failing tests for archive entries, nested folders, and traversal rejection.
- [ ] Implement `workspaceArchive.ts` with CRC32, ZIP local headers, central directory, and safe file collection.
- [ ] Run `npx tsx --test apps/api/src/routes/workspaceArchive.test.ts`.

## Task 2: Backend Download Endpoint

- [ ] Add `GET /api/workspace/:sessionId/download?path=/workspace/...`.
- [ ] For files, return the raw file content with attachment headers.
- [ ] For directories, return ZIP content with attachment headers.
- [ ] Reuse existing session ownership and workspace path guards.
- [ ] Run backend tests and `npx tsc --noEmit -p apps/api/tsconfig.json`.

## Task 3: Frontend File Helpers and API

- [ ] Add failing helper tests for `.ppt`, `.pptx`, `.docx`, binary extension detection, and folder download names.
- [ ] Implement `isEditableWorkspaceFile`, `workspaceDownloadName`, and `downloadWorkspacePath`.
- [ ] Run `npx tsx --test apps/web/src/lib/workspaceFile.test.ts`.

## Task 4: Files UI and Fullscreen Editor

- [ ] Extend `FileTree` with `onOpenFile` and `onDownloadPath` callbacks.
- [ ] Single click keeps opening the inline editor.
- [ ] Double click opens a fullscreen centered editor.
- [ ] Directory rows expose a download icon that downloads ZIP.
- [ ] File rows expose a download icon that downloads the file.
- [ ] `WorkspaceFileEditor` gets fullscreen layout and maximize/minimize controls.
- [ ] PPT/PPTX files show a non-text artifact message with download action instead of Monaco editing.
- [ ] Run `npx tsc --noEmit -p apps/web/tsconfig.json`.

## Task 5: Playwright Verification

- [ ] Start API and Web dev servers.
- [ ] Use Playwright to create/login as a test user or use dev token.
- [ ] Create a session and seed a workspace file/folder through the API or sandbox directory.
- [ ] Verify folder download button triggers a `.zip` download.
- [ ] Verify single click opens inline editor.
- [ ] Verify double click opens centered fullscreen editor.
- [ ] Verify editing and saving updates the workspace file.
- [ ] Verify `.pptx` opens the non-text artifact message and can be downloaded.
- [ ] Run `npm run build --workspace @agenthub/web`.

## Task 6: Review

- [ ] Check scope, file boundaries, compatibility, exceptional states, and duplication.
- [ ] Confirm no unrelated dirty files are staged or committed.
