import { useState, useEffect } from 'react';
import { FolderOpen, Shield, Zap, X } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  sessionId: string;
  onClose: () => void;
  onWorkspaceChanged?: (path: string) => void;
}

export function WorkspaceSelector({ sessionId, onClose, onWorkspaceChanged }: Props) {
  const [path, setPath] = useState('');
  const [writePermission, setWritePermission] = useState<'ask' | 'auto'>('ask');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentWorkspace, setCurrentWorkspace] = useState<{ path: string | null; writePermission: string } | null>(null);

  useEffect(() => {
    api.getSessionWorkspace(sessionId).then(setCurrentWorkspace).catch(console.error);
  }, [sessionId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setError('Path is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.setSessionWorkspace(sessionId, {
        path: path.trim(),
        mode: 'custom',
        writePermission,
      });
      onWorkspaceChanged?.(result.path);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to set workspace');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-hub-raised border border-hub rounded-hub-xl shadow-2xl w-96 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-hub-primary">Set Workspace Directory</h3>
          <button onClick={onClose} className="p-1 hover:bg-hub-hover rounded">
            <X className="w-4 h-4 text-hub-tertiary" />
          </button>
        </div>

        {currentWorkspace?.path && (
          <div className="mb-4 p-3 bg-hub-surface rounded-hub-lg">
            <div className="text-[10px] text-hub-tertiary uppercase tracking-wider mb-1">Current Workspace</div>
            <div className="text-xs text-hub-secondary font-mono break-all">{currentWorkspace.path}</div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-hub-tertiary mb-1 block">Directory Path</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/home/user/projects/my-project"
                className="flex-1 px-3 py-2 text-xs bg-hub-surface border border-hub-border rounded-hub-lg text-hub-primary focus:outline-none focus:border-hub-accent font-mono"
              />
              <button
                type="button"
                onClick={() => {
                  // Native file dialog would go here
                  // For now, just focus the input
                }}
                className="p-2 bg-hub-surface border border-hub-border rounded-hub-lg hover:bg-hub-hover transition"
                title="Browse"
              >
                <FolderOpen className="w-4 h-4 text-hub-tertiary" />
              </button>
            </div>
          </div>

          <div>
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

          {error && (
            <div className="text-xs text-hub-danger bg-hub-danger/10 px-3 py-2 rounded-hub-lg">
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs text-hub-secondary hover:bg-hub-hover rounded-hub-lg transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !path.trim()}
              className="px-4 py-2 text-xs bg-hub-accent text-white rounded-hub-lg hover:bg-hub-accent-hover transition disabled:opacity-50"
            >
              {loading ? 'Setting...' : 'Set Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
