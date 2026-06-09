import { useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

export function RemoveAgentModal({ sessionId, open, onClose }: Props) {
  const sessions = useAppStore((s) => s.sessions);
  const agents = useAppStore((s) => s.agents);
  const removeAgentFromSession = useAppStore((s) => s.removeAgentFromSession);
  const setAgents = useAppStore((s) => s.setAgents);
  const [removing, setRemoving] = useState<Set<string>>(new Set());

  const session = sessions.find((s) => s.id === sessionId);
  const sessionAgents = ((session as any)?.agents || [])
    .map((sa: any) => agents.find((a) => a.id === sa.agentId))
    .filter(Boolean);

  const handleRemove = async (agentId: string) => {
    setRemoving((prev) => new Set(prev).add(agentId));
    try {
      await api.removeAgentFromSession(sessionId, agentId);
      removeAgentFromSession(sessionId, agentId);

      // If agent has no other sessions, delete it entirely
      const otherSessions = sessions.filter(
        (s) => s.id !== sessionId && s.agents?.some((sa: any) => sa.agentId === agentId),
      );
      if (otherSessions.length === 0) {
        await api.deleteAgent(agentId);
        api.getAgents().then(setAgents).catch(console.error);
      }

      onClose();
    } catch (err) {
      console.error('Failed to remove agent:', err);
    } finally {
      setRemoving((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50">
        <div className="glass-surface-heavy border border-hub rounded-hub-xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col m-4">
          <div className="flex items-center justify-between px-5 py-4 border-b border-hub">
            <h2 className="text-base font-semibold text-hub-primary">Remove Agent from Group</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-tertiary">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {sessionAgents.length === 0 && (
              <p className="text-sm text-hub-muted text-center py-6">No agents to remove</p>
            )}
            {sessionAgents.map((agent: any) => (
              <div
                key={agent.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-hub-border group hover:border-hub-danger/30 transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-hub-primary">{agent.displayName}</div>
                  <div className="text-xs text-hub-tertiary truncate">{agent.description}</div>
                </div>
                <button
                  onClick={() => handleRemove(agent.id)}
                  disabled={removing.has(agent.id)}
                  className="p-2 rounded-md text-hub-tertiary hover:text-hub-danger hover:bg-hub-danger/10 opacity-0 group-hover:opacity-100 transition disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
