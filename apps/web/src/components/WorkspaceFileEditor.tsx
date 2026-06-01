import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Download, FileText, RefreshCw, Save, X } from 'lucide-react';
import { api } from '../lib/api';
import { displayWorkspacePath, inferWorkspaceLanguage, safeDownloadName } from '../lib/workspaceFile';

interface Props {
  sessionId: string;
  path: string;
  onClose: () => void;
  onSaved?: () => void;
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

export function WorkspaceFileEditor({ sessionId, path, onClose, onSaved }: Props) {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useMemo(() => inferWorkspaceLanguage(path), [path]);
  const dirty = loaded !== null && content !== loaded.content;

  const loadFile = async () => {
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
  }, [sessionId, path]);

  const save = async () => {
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

  return (
    <div className="flex min-h-[420px] flex-col overflow-hidden rounded-md border border-hub bg-hub-surface">
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
          disabled={loading || saving || !dirty}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-success hover:bg-hub-hover disabled:opacity-40"
          title="Save"
        >
          <Save className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={download}
          disabled={loading || loaded === null}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-link hover:bg-hub-hover disabled:opacity-40"
          title="Save as local file"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
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

      <div className="min-h-0 flex-1">
        <Editor
          height="420px"
          language={language}
          value={content}
          theme="vs-dark"
          loading={<div className="px-3 py-2 text-xs text-hub-muted">Loading...</div>}
          onChange={(value) => setContent(value ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
