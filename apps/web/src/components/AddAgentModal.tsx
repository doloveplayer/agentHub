import { useState } from 'react';
import { X, Plus, Search } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { CreateAgentModal } from './CreateAgentModal';
import type { AgentConfig } from '@agenthub/shared';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

export function AddAgentModal({ sessionId, open, onClose }: Props) {
  const agents = useAppStore((s) => s.agents);
  const sessions = useAppStore((s) => s.sessions);
  const user = useAppStore((s) => s.user);
  const addAgentToSession = useAppStore((s) => s.addAgentToSession);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [showCreateAgent, setShowCreateAgent] = useState(false);

  const session = sessions.find((s) => s.id === sessionId);
  const sessionAgentIds = new Set(((session as any)?.agents || []).map((a: any) => a.agentId));

  // Only show user's own agents (not system agents, not other users' agents)
  const availableAgents = agents.filter((a) => {
    if (a.type === 'system') return false;
    if (a.createdBy !== user?.id) return false;
    if (sessionAgentIds.has(a.id)) return false;
    if (search && !a.displayName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleAdd = async () => {
    if (selected.size === 0) return;
    setAdding(true);
    try {
      await api.addSessionAgents(sessionId, Array.from(selected));
      for (const agentId of selected) {
        const agent = agents.find((a) => a.id === agentId);
        if (agent) addAgentToSession(sessionId, agent);
      }
      onClose();
    } catch (err) {
      console.error('Failed to add agents:', err);
    } finally {
      setAdding(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50">
        <div className="glass-surface-heavy border border-hub rounded-hub-xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col m-4">
          <div className="flex items-center justify-between px-5 py-4 border-b border-hub">
            <h2 className="text-base font-semibold text-hub-primary">Add Agent to Group</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-tertiary">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 border-b border-hub">
            <button
              onClick={() => setShowCreateAgent(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-dashed border-hub-accent/30 text-hub-accent hover:bg-hub-accent/5 transition text-sm"
            >
              <Plus className="w-4 h-4" /> Create New Agent
            </button>
          </div>

          <div className="px-5 py-3 border-b border-hub">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hub-tertiary" />
              <input
                type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents..." autoFocus
                className="w-full pl-9 pr-3 py-2 bg-hub-surface border border-hub-border rounded-lg text-sm text-hub-primary outline-none focus:border-hub-accent"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {availableAgents.length === 0 && (
              <p className="text-sm text-hub-muted text-center py-6">No agents available</p>
            )}
            {availableAgents.map((agent) => (
              <label key={agent.id}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer border transition ${
                  selected.has(agent.id) ? 'border-hub-accent bg-hub-accent/10' : 'border-hub-border hover:border-hub-accent/50'
                }`}
                onClick={() => toggleSelect(agent.id)}
              >
                <input type="checkbox" checked={selected.has(agent.id)} onChange={() => {}} className="accent-hub-accent" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-hub-primary">{agent.displayName}</div>
                  <div className="text-xs text-hub-tertiary truncate">{agent.description}</div>
                </div>
              </label>
            ))}
          </div>

          <div className="px-5 py-3 border-t border-hub flex items-center justify-between">
            <span className="text-xs text-hub-tertiary">{selected.size} selected</span>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2 text-sm text-hub-secondary hover:bg-hub-hover rounded-md transition">
                Cancel
              </button>
              <button onClick={handleAdd} disabled={selected.size === 0 || adding}
                className="px-4 py-2 text-sm bg-hub-accent text-white rounded-md hover:bg-hub-accent-hover disabled:opacity-40 transition font-medium"
              >
                {adding ? 'Adding...' : `Add (${selected.size})`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showCreateAgent && (
        <CreateAgentModal
          open={showCreateAgent}
          groupSessionId={sessionId}
          onClose={() => setShowCreateAgent(false)}
          onCreated={() => { setShowCreateAgent(false); onClose(); }}
        />
      )}
    </>
  );
}
