import { useState, useEffect } from 'react';
import { X, Save, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';

interface Props {
  sessionId: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function AgentConfigEditor({ sessionId, agentId, agentName, onClose, onSaved }: Props) {
  const [override, setOverride] = useState<string>('');
  const [globalPrompt, setGlobalPrompt] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, [sessionId, agentId]);

  const loadConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const config = await api.getSessionAgentConfig(sessionId, agentId);
      setOverride(config.systemPromptOverride || '');
      setGlobalPrompt(config.globalSystemPrompt);
    } catch (err: any) {
      setError(err.message || 'Failed to load config');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSessionAgentConfig(sessionId, agentId, override || undefined);
      onSaved?.();
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setOverride('');
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-hub-surface rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-hub">
          <h3 className="text-body font-semibold text-hub-primary">
            Configure {agentName}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-hub-muted">
              Loading...
            </div>
          ) : (
            <>
              {/* Session Override */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-hub-primary">
                    Session Override
                  </label>
                  {override && (
                    <button
                      onClick={handleReset}
                      className="flex items-center gap-1 text-xs text-hub-muted hover:text-hub-accent"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset to global
                    </button>
                  )}
                </div>
                <textarea
                  value={override}
                  onChange={(e) => setOverride(e.target.value)}
                  placeholder="Leave empty to use global config..."
                  className="w-full h-48 px-3 py-2 rounded-lg bg-hub-raised border border-hub
                             text-hub-primary text-sm font-mono resize-none focus:border-hub-accent focus:outline-none"
                />
                <p className="text-[10px] text-hub-muted mt-1">
                  This override only affects this session. Leave empty to use the global system prompt.
                </p>
              </div>

              {/* Global Config (read-only) */}
              <div>
                <label className="text-sm font-medium text-hub-primary mb-2 block">
                  Global System Prompt (read-only)
                </label>
                <div className="w-full h-32 px-3 py-2 rounded-lg bg-hub-raised border border-hub
                                text-hub-muted text-sm font-mono overflow-y-auto">
                  {globalPrompt || 'No global system prompt'}
                </div>
              </div>

              {/* Warning */}
              <div className="p-3 rounded-lg bg-hub-warning/10 border border-hub-warning/20">
                <p className="text-xs text-hub-warning">
                  This modification only affects the agent in this session. Other sessions will continue to use the global config.
                </p>
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg bg-hub-danger/10 border border-hub-danger/20 text-hub-danger text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hub">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-hub-secondary hover:bg-hub-hover transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-hub-accent text-white text-sm
                       hover:bg-hub-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {saving ? (
              <span className="animate-spin">⏳</span>
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
