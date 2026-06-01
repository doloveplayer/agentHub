import { useState, useEffect, useCallback } from 'react';
import { FolderOpen, Shield, Zap, X, ChevronRight, Home, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  sessionId: string;
  onClose: () => void;
  onWorkspaceChanged?: (path: string) => void;
}

interface DirEntry {
  name: string;
  path: string;
}

export function WorkspaceSelector({ sessionId, onClose, onWorkspaceChanged }: Props) {
  const [currentPath, setCurrentPath] = useState('/home');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [writePermission, setWritePermission] = useState<'ask' | 'auto'>('ask');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentWorkspace, setCurrentWorkspace] = useState<{ path: string | null; writePermission: string } | null>(null);

  useEffect(() => {
    api.getSessionWorkspace(sessionId).then(setCurrentWorkspace).catch(console.error);
  }, [sessionId]);

  const browseDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browseDirectory(dirPath);
      setCurrentPath(result.path);
      setDirs(result.dirs);
    } catch (err: any) {
      setError(err.message || 'Failed to browse directory');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load initial directory on mount
  useEffect(() => {
    browseDir('/home');
  }, [browseDir]);

  const handleSelect = (dirPath: string) => {
    setSelectedPath(dirPath);
    setError(null);
    browseDir(dirPath);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalPath = selectedPath || currentPath;
    if (!finalPath.trim()) {
      setError('Please select a directory');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await api.setSessionWorkspace(sessionId, {
        path: finalPath.trim(),
        mode: 'custom',
        writePermission,
      });
      onWorkspaceChanged?.(result.path);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to set workspace');
    } finally {
      setSubmitting(false);
    }
  };

  // Breadcrumb segments
  const segments = currentPath.split('/').filter(Boolean);
  const breadcrumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const seg of segments) {
    acc += '/' + seg;
    breadcrumbs.push({ label: seg, path: acc });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-hub-raised border border-hub rounded-hub-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-hub-primary">Select Workspace Directory</h3>
          <button onClick={onClose} className="p-1 hover:bg-hub-hover rounded">
            <X className="w-4 h-4 text-hub-tertiary" />
          </button>
        </div>

        {/* Current workspace */}
        {currentWorkspace?.path && (
          <div className="mb-3 p-2.5 bg-hub-surface rounded-hub-lg text-xs">
            <span className="text-hub-tertiary">Current: </span>
            <span className="text-hub-secondary font-mono break-all">{currentWorkspace.path}</span>
          </div>
        )}

        {/* Breadcrumb navigation */}
        <div className="flex items-center gap-1 mb-2 text-xs text-hub-tertiary overflow-x-auto pb-1 flex-shrink-0">
          {breadcrumbs.map((bc, i) => (
            <span key={bc.path} className="flex items-center gap-1 whitespace-nowrap">
              {i > 0 && <ChevronRight className="w-3 h-3 flex-shrink-0" />}
              <button
                onClick={() => handleSelect(bc.path)}
                className="hover:text-hub-primary hover:underline transition"
              >
                {i === 0 ? <Home className="w-3 h-3" /> : bc.label}
              </button>
            </span>
          ))}
          <button
            onClick={() => browseDir(currentPath)}
            className="ml-1 p-0.5 hover:bg-hub-hover rounded transition flex-shrink-0"
            title="Refresh"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Selected path */}
        {selectedPath && selectedPath !== currentPath && (
          <div className="mb-2 px-2 py-1 bg-hub-accent/10 rounded text-xs text-hub-accent font-mono truncate">
            Selected: {selectedPath}
          </div>
        )}

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto border border-hub-border rounded-hub-lg bg-hub-surface mb-4 min-h-[200px] max-h-[350px]">
          {loading && dirs.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-xs text-hub-tertiary">
              Loading...
            </div>
          ) : dirs.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-xs text-hub-tertiary">
              No subdirectories
            </div>
          ) : (
            dirs.map((d) => (
              <button
                key={d.path}
                type="button"
                onClick={() => handleSelect(d.path)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition border-b border-hub-border/30 last:border-b-0 hover:bg-hub-hover ${
                  d.path === selectedPath ? 'bg-hub-accent/15 text-hub-accent' : 'text-hub-secondary'
                }`}
              >
                <FolderOpen className={`w-3.5 h-3.5 flex-shrink-0 ${
                  d.name === '..' ? 'text-hub-tertiary' : 'text-hub-warning'
                }`} />
                <span className="truncate font-mono">{d.name}</span>
                {d.name !== '..' && (
                  <span className="ml-auto text-[10px] text-hub-tertiary flex-shrink-0">select</span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Write permission */}
        <div className="mb-4">
          <label className="text-xs text-hub-tertiary mb-2 block">Write Permission</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setWritePermission('ask')}
              className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-hub-lg border transition ${
                writePermission === 'ask'
                  ? 'border-hub-warning bg-hub-warning/10 text-hub-warning'
                  : 'border-hub-border bg-hub-surface text-hub-tertiary hover:bg-hub-hover'
              }`}
            >
              <Shield className="w-4 h-4" />
              <div className="text-left">
                <div className="text-xs font-medium">Ask</div>
                <div className="text-[10px] opacity-70">Request approval</div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setWritePermission('auto')}
              className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-hub-lg border transition ${
                writePermission === 'auto'
                  ? 'border-hub-success bg-hub-success/10 text-hub-success'
                  : 'border-hub-border bg-hub-surface text-hub-tertiary hover:bg-hub-hover'
              }`}
            >
              <Zap className="w-4 h-4" />
              <div className="text-left">
                <div className="text-xs font-medium">Auto</div>
                <div className="text-[10px] opacity-70">Auto-approve</div>
              </div>
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-3 text-xs text-hub-danger bg-hub-danger/10 px-3 py-2 rounded-hub-lg">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs text-hub-secondary hover:bg-hub-hover rounded-hub-lg transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-xs bg-hub-accent text-white rounded-hub-lg hover:bg-hub-accent-hover transition disabled:opacity-50"
          >
            {submitting ? 'Setting...' : submittedPathLabel(selectedPath || currentPath)}
          </button>
        </div>
      </div>
    </div>
  );
}

function submittedPathLabel(p: string): string {
  const trimmed = p.replace(/\/$/, '') || '/';
  // Show last 2 segments for readability
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length <= 2) return `Use "${trimmed}"`;
  return `Use ".../${parts.slice(-2).join('/')}"`;
}
