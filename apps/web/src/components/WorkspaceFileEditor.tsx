import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Download, FileText, Maximize2, Minimize2, RefreshCw, Save, X } from 'lucide-react';
import { api } from '../lib/api';
import { displayWorkspacePath, inferWorkspaceLanguage, isEditableWorkspaceFile, safeDownloadName } from '../lib/workspaceFile';

interface Props {
  sessionId: string;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onDownloadOriginal?: (path: string) => void;
}

interface LoadedFile {
  content: string;
  size?: number;
  modifiedAt?: string;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

export function WorkspaceFileEditor({
  sessionId,
  path,
  onClose,
  onSaved,
  fullscreen = false,
  onToggleFullscreen,
  onDownloadOriginal,
}: Props) {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useMemo(() => inferWorkspaceLanguage(path), [path]);
  const editable = useMemo(() => isEditableWorkspaceFile(path), [path]);
  const dirty = loaded !== null && content !== loaded.content;

  const loadFile = async () => {
    if (!editable) {
      setLoaded(null);
      setContent('');
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const file = await api.getWorkspaceFile(sessionId, path);
      const next = {
        content: String(file.content ?? ''),
        size: typeof file.size === 'number' ? file.size : undefined,
        modifiedAt: typeof file.modifiedAt === 'string' ? file.modifiedAt : undefined,
      };
      setLoaded(next);
      setContent(next.content);
    } catch (err: any) {
      setError(err?.message || 'Failed to load file');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoaded(null);
    setContent('');
    loadFile();
  }, [sessionId, path, editable]);

  const save = async () => {
    if (!editable) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateWorkspaceFile(sessionId, path, content);
      setLoaded({ content, size: result.size, modifiedAt: result.modifiedAt });
      onSaved?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to save file');
    } finally {
      setSaving(false);
    }
  };

  const download = () => {
    if (!editable) {
      onDownloadOriginal?.(path);
      return;
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeDownloadName(path);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const editorHeight = fullscreen ? 'calc(100vh - 164px)' : '420px';

  const editor = (
    <div data-testid={fullscreen ? 'workspace-editor-fullscreen' : 'workspace-editor-inline'} className={`flex flex-col overflow-hidden rounded-md border border-hub bg-hub-surface ${
      fullscreen
        ? 'fixed left-1/2 top-1/2 z-50 h-[calc(100vh-48px)] w-[min(1180px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 shadow-2xl'
        : 'min-h-[420px]'
    }`}>
      <div className="flex items-center gap-2 border-b border-hub px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-hub-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-hub-primary">{safeDownloadName(path)}</div>
          <div className="truncate text-[11px] text-hub-muted">{displayWorkspacePath(path)}</div>
        </div>
        {dirty && (
          <span className="rounded bg-hub-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-hub-warning">
            Unsaved
          </span>
        )}
        <button
          onClick={loadFile}
          disabled={loading || saving}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button
          onClick={save}
          disabled={loading || saving || !dirty || !editable}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-success hover:bg-hub-hover disabled:opacity-40"
          title="Save"
        >
          <Save className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={download}
          disabled={loading || (editable && loaded === null)}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-link hover:bg-hub-hover disabled:opacity-40"
          title={editable ? 'Save as local file' : 'Download file'}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover"
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen editor'}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {(loaded?.size !== undefined || loaded?.modifiedAt) && (
        <div className="border-b border-hub px-3 py-1 text-[11px] text-hub-muted">
          {loaded.size !== undefined && <span>{formatSize(loaded.size)}</span>}
          {loaded.modifiedAt && <span className="ml-2">{new Date(loaded.modifiedAt).toLocaleString()}</span>}
        </div>
      )}

      {error && (
        <div className="border-b border-hub bg-hub-danger/10 px-3 py-2 text-xs text-hub-danger">
          {error}
        </div>
      )}

      {editable ? (
        <div className="min-h-0 flex-1">
          <Editor
            height={editorHeight}
            language={language}
            value={content}
            theme="vs-dark"
            loading={<div className="px-3 py-2 text-xs text-hub-muted">Loading...</div>}
            onChange={(value) => setContent(value ?? '')}
            options={{
              minimap: { enabled: fullscreen },
              fontSize: fullscreen ? 13 : 12,
              lineNumbersMinChars: 3,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
            }}
          />
        </div>
      ) : (
        <div className="flex min-h-[260px] flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileText className="h-10 w-10 text-hub-muted" />
          <div>
            <div className="text-sm font-medium text-hub-primary">Binary artifact</div>
            <div className="mt-1 max-w-md text-xs leading-5 text-hub-muted">
              This file type cannot be edited safely as text in the browser. Download it and edit it with a desktop app, then ask an agent to regenerate or replace it.
            </div>
          </div>
          <button
            onClick={download}
            className="inline-flex items-center gap-2 rounded bg-hub-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-hub-accent-hover"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        </div>
      )}
    </div>
  );

  if (!fullscreen) return editor;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/70" onClick={onClose} />
      {editor}
    </>
  );
}
