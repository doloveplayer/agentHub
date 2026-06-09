# Agent Output Workspace Editor Design

## Goal

When an agent creates or modifies a document, code file, or other text artifact in the session workspace, the user can open it in the browser, edit it, save the changes back to the session sandbox, and download the current editor contents to their local machine.

## Scope

This feature covers text-like workspace files exposed through the existing Files panel. It does not add a new artifact database model, a standalone artifact route, binary editing, or cross-session file sharing.

The user-facing save semantics are:

- Save writes the current editor content back to the selected file in `.sandboxes/{sessionId}`.
- Save As downloads the current editor content through the browser as a local file and does not create a new server-side workspace path.
- Refresh reloads the selected file from the workspace and warns through dirty-state UI if the editor has unsaved changes.

## Architecture

The current backend already exposes authenticated workspace tree and file-read endpoints from `apps/api/src/routes/workspace.ts`. The feature extends that route with a `PUT /api/workspace/:sessionId/file` endpoint that reuses the same ownership and path traversal guards before writing UTF-8 content to the selected workspace file.

The current frontend already renders the Files tab with `FileTree` inside `AgentStatusPanel`, and the web package already depends on `@monaco-editor/react`. The feature adds a focused `WorkspaceFileEditor` component in the Files tab. `FileTree` remains responsible only for browsing and selecting files. `WorkspaceFileEditor` is responsible for loading file content, tracking dirty state, presenting editor actions, saving through the API, and downloading the in-memory content.

The data flow is:

1. User opens the Files tab.
2. User selects a file in `FileTree`.
3. `AgentStatusPanel` stores the selected workspace path and renders `WorkspaceFileEditor`.
4. `WorkspaceFileEditor` calls `api.getWorkspaceFile(sessionId, path)`.
5. User edits content in Monaco.
6. Save calls `api.updateWorkspaceFile(sessionId, path, content)`.
7. Save As creates a `Blob` from the current content and triggers a browser download.

## Backend Behavior

`PUT /api/workspace/:sessionId/file` accepts JSON:

```json
{
  "path": "/workspace/docs/report.md",
  "content": "# Updated report\n"
}
```

Validation rules:

- The requester must own the session.
- `path` must be a non-empty string.
- `content` must be a string.
- The resolved path must remain inside the session sandbox root after stripping an optional `/workspace/` prefix.
- The target must not be a directory.

The response is:

```json
{
  "path": "/workspace/docs/report.md",
  "size": 17,
  "modifiedAt": "2026-06-01T00:00:00.000Z"
}
```

Failure behavior:

- Missing or invalid input returns `400`.
- Non-owned sessions return `403`.
- Path traversal returns `403`.
- Filesystem write/read errors return a non-secret error message and do not expose host paths.

## Frontend Behavior

`WorkspaceFileEditor` displays:

- File name and workspace path.
- Save, Save As, Refresh, and Close icon buttons with tooltips.
- Dirty state when editor content differs from the last loaded or saved content.
- Lightweight metadata: size and modified time when available.
- Loading and error states.

Editor behavior:

- Uses Monaco for text editing.
- Infers language from file extension for common artifact types such as TypeScript, JavaScript, JSON, Markdown, CSS, HTML, YAML, Python, shell, SQL, and plaintext.
- Opens selected files in-place inside the Files tab, below or beside the file tree depending on available panel width.
- Keeps the existing Files tab dense and consistent with the current dark UI.

Download behavior:

- Uses the current in-memory editor content.
- Uses the selected file basename as the browser download name.
- Falls back to `artifact.txt` if the path does not contain a safe basename.

## Event Integration

The existing workspace tree remains the reliable artifact entry point. The current backend already emits milestone events such as `file_produced`, but the frontend event type currently does not model them. This feature may expand the frontend `AgentEvent` type to include `file_produced` for compatibility, but it does not change the WebSocket protocol or require agent messages to carry artifact metadata.

## Compatibility

Existing REST response shapes remain unchanged. The new write endpoint is additive. Existing `GET /api/workspace/:sessionId/file` behavior remains compatible.

The feature does not change Prisma schema, WebSocket payload names, message statuses, permission modes, or Docker sandbox lifecycle behavior.

## Security

Workspace writes must use the same session ownership and path traversal constraints as workspace reads. The backend must not allow absolute host paths, `..` traversal, or writes outside `.sandboxes/{sessionId}`.

The API writes only the submitted file content. It must not execute user content or shell commands.

## Testing

Backend tests cover:

- Successful write to a session-owned workspace file.
- Rejection of path traversal attempts.
- Rejection of writes against a session owned by another user.

Frontend tests cover:

- Language inference from workspace file names.
- Download filename derivation and sanitization.

Verification commands:

```bash
node --test apps/api/src/routes/workspace.test.ts
node --test apps/web/src/lib/workspaceFile.test.ts
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
npm run build --workspace @agenthub/web
```

## Self-Review

- No unfinished requirement markers remain.
- Scope is limited to text-like workspace artifact editing, saving, and browser download.
- The backend and frontend responsibilities are separate and match existing project boundaries.
- No database, WebSocket, Docker, or provider contract changes are required.
