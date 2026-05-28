import { useEffect, useState } from 'react';
import { Plus, MessageSquare, Trash2, Users, X, AlertTriangle, Loader2, RefreshCw, Pencil } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

interface Props { onCloseMobile?: () => void; }

type LoadState = 'loading' | 'error' | 'done';

export function SessionList({ onCloseMobile }: Props) {
  const { sessions, activeSessionId, setSessions, setActiveSession, setAgents, user, unreadCounts, clearUnread, sessionPermissionModes, setSessionPermissionMode } = useAppStore();
  const [showCreate, setShowCreate] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const loadSessions = () => {
    setLoadState('loading');
    api.getSessions()
      .then((data) => {
        setSessions(data);
        // Populate session permission modes from loaded data
        const modes: Record<string, string> = {};
        for (const s of data) {
          if (s.permissionMode) modes[s.id] = s.permissionMode;
        }
        useAppStore.setState((state) => ({
          sessionPermissionModes: { ...state.sessionPermissionModes, ...modes },
        }));
        setLoadState('done');
      })
      .catch(() => {
        setLoadState('error');
      });
  };

  useEffect(() => {
    loadSessions();
  }, []);

  const [customAgentMode, setCustomAgentMode] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customDisplay, setCustomDisplay] = useState('');
  const [customDesc, setCustomDesc] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');

  const handleCreate = async (type: 'solo' | 'group') => {
    if (type === 'solo' && customAgentMode && customDisplay && customDesc && customPrompt) {
      let name = customName || customDisplay.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
      if (!name || name.length < 2) name = 'custom-agent-' + Date.now().toString(36);
      const session = await api.createSession({
        type: 'solo',
        customAgent: { name, displayName: customDisplay, description: customDesc, systemPrompt: customPrompt },
      });
      setSessions([session, ...sessions]);
      // Refresh agents store so ChatView agentMap finds the new custom agent
      api.getAgents().then(setAgents).catch(console.error);
      if (session.permissionMode) setSessionPermissionMode(session.id, session.permissionMode);
      setActiveSession(session.id);
      resetCreate();
      return;
    }
    const session = await api.createSession(type === 'group' ? { type: 'group' } : {});
    setSessions([session, ...sessions]);
    if (session.permissionMode) {
      setSessionPermissionMode(session.id, session.permissionMode);
    }
    setActiveSession(session.id);
    resetCreate();
  };

  const resetCreate = () => {
    setShowCreate(false);
    setCustomAgentMode(false);
    setCustomName('');
    setCustomDisplay('');
    setCustomDesc('');
    setCustomPrompt('');
  };

  const handleSelect = async (id: string) => {
    setActiveSession(id);
    clearUnread(id);
    const session = await api.getSession(id);
    useAppStore.setState((s) => ({
      messages: { ...s.messages, [id]: session.messages },
    }));
  };

  const handleDeleteClick = (id: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ id, title });
  };

  const handleStartRename = (id: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingTitle(title);
  };

  const handleSaveRename = async (id: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== sessions.find(s => s.id === id)?.title) {
      try {
        await api.updateSession(id, { title: trimmed });
        useAppStore.getState().updateSessionInList(id, { title: trimmed });
      } catch { /* ignore */ }
    }
    setEditingId(null);
    setEditingTitle('');
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    await api.deleteSession(id);
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    if (activeSessionId === id) {
      // Find nearest session: prefer the one right after in the list, else first, else null
      const idx = sessions.findIndex((s) => s.id === id);
      const next = remaining[Math.min(idx, remaining.length - 1)];
      setActiveSession(next?.id ?? null);
    }
    setDeleteTarget(null);
  };

  const cancelDelete = () => setDeleteTarget(null);

  return (
    <div className="w-full h-full bg-hub-surface border-r border-hub flex flex-col">
      <div className="p-4 border-b border-hub flex items-center justify-between">
        <h2 className="font-semibold text-hub-primary">Sessions</h2>
        {onCloseMobile && (
          <button onClick={onCloseMobile} className="md:hidden p-1 hover:bg-hub-hover rounded">
            <X className="w-4 h-4 text-hub-tertiary" />
          </button>
        )}
        <div className="relative">
          <button onClick={() => setShowCreate(!showCreate)} className="p-1.5 hover:bg-hub-hover rounded-hub-lg transition" title="New Session">
            <Plus className="w-4 h-4 text-hub-tertiary" />
          </button>
          {showCreate && (
            <div className="absolute top-full right-0 mt-1 bg-hub-raised border border-hub rounded-hub-lg shadow-xl z-50 w-72 overflow-hidden">
              {!customAgentMode ? (
                <>
                  <button onClick={() => handleCreate('solo')} className="w-full text-left px-4 py-2.5 text-sm text-hub-secondary hover:bg-hub-hover flex items-center gap-2 transition font-medium">
                    <MessageSquare className="w-3.5 h-3.5" /> Solo Session (Default Agent)
                  </button>
                  <button onClick={() => setCustomAgentMode(true)} className="w-full text-left px-4 py-2.5 text-sm text-hub-secondary hover:bg-hub-hover flex items-center gap-2 transition font-medium border-t border-hub">
                    <MessageSquare className="w-3.5 h-3.5" /> Solo Session (Custom Agent)
                  </button>
                  <button onClick={() => handleCreate('group')} className="w-full text-left px-4 py-2.5 text-sm text-hub-secondary hover:bg-hub-hover flex items-center gap-2 transition font-medium border-t border-hub">
                    <Users className="w-3.5 h-3.5" /> Group Session
                  </button>
                </>
              ) : (
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-hub-primary">Custom Agent</span>
                    <button onClick={resetCreate} className="p-0.5 hover:bg-hub-hover rounded text-hub-tertiary">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <input
                    type="text" value={customDisplay} onChange={e => setCustomDisplay(e.target.value)}
                    placeholder="Display Name *" autoFocus
                    className="w-full px-2 py-1.5 text-xs bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent"
                  />
                  <input
                    type="text" value={customDesc} onChange={e => setCustomDesc(e.target.value)}
                    placeholder="Description (e.g. Python data analyst)"
                    className="w-full px-2 py-1.5 text-xs bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent"
                  />
                  <textarea
                    value={customPrompt} onChange={e => setCustomPrompt(e.target.value)}
                    placeholder="System Prompt (role, capabilities, constraints...)" rows={4}
                    className="w-full px-2 py-1.5 text-xs bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent resize-none"
                  />
                  <button
                    onClick={() => handleCreate('solo')}
                    disabled={!customDisplay || !customDesc || !customPrompt}
                    className="w-full px-3 py-1.5 text-xs font-medium bg-hub-accent text-white rounded hover:bg-hub-accent-hover transition disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto panel-scroll">
        {loadState === 'loading' && (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="w-5 h-5 text-hub-tertiary animate-spin" />
            <span className="ml-2 text-sm text-hub-muted">Loading sessions...</span>
          </div>
        )}

        {loadState === 'error' && (
          <div className="flex flex-col items-center justify-center p-8 gap-3">
            <AlertTriangle className="w-6 h-6 text-hub-warning" />
            <p className="text-sm text-hub-muted">Failed to load sessions</p>
            <button
              onClick={loadSessions}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-hub-accent hover:bg-hub-accent/10 rounded-md transition"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}

        {loadState === 'done' && sessions.map((s: any) => (
          <div
            key={s.id}
            onClick={() => handleSelect(s.id)}
            className={`px-4 py-3 cursor-pointer hover:bg-hub-hover flex items-start gap-2.5 group transition-all duration-hub border-l-[3px] ${
              activeSessionId === s.id ? 'bg-hub-active border-l-hub-accent' : 'border-l-transparent'
            }`}
          >
            {s.type === 'group' ? (
              <Users className="w-4 h-4 mt-0.5 text-hub-accent shrink-0" />
            ) : (
              <MessageSquare className="w-4 h-4 mt-0.5 text-hub-tertiary shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm text-hub-secondary truncate flex items-center gap-1.5">
                {editingId === s.id ? (
                  <input
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => handleSaveRename(s.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRename(s.id); if (e.key === 'Escape') { setEditingId(null); setEditingTitle(''); } }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    className="bg-hub-input border border-hub-accent rounded px-1.5 py-0.5 text-sm text-hub-primary w-full outline-none"
                  />
                ) : (
                  <>
                    <span className="truncate">{s.title}</span>
                    <button
                      onClick={(e) => handleStartRename(s.id, s.title, e)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-hub-hover rounded shrink-0 transition"
                      title="Rename"
                    >
                      <Pencil className="w-3 h-3 text-hub-tertiary" />
                    </button>
                  </>
                )}
                {s.type === 'group' && s.agents && (
                  <span className="text-[10px] text-hub-tertiary shrink-0">
                    ({s.agents.length})
                  </span>
                )}
                {(unreadCounts[s.id] || 0) > 0 && activeSessionId !== s.id && (
                  <span className="ml-auto bg-hub-accent text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0">
                    {unreadCounts[s.id] > 99 ? '99+' : unreadCounts[s.id]}
                  </span>
                )}
              </div>
              {s.lastMessage && (
                <div className="text-xs text-hub-tertiary truncate mt-0.5">
                  {s.lastMessage.senderType === 'human' ? 'You: ' : ''}{s.lastMessage.content}
                </div>
              )}
            </div>
            <button
              onClick={(e) => handleDeleteClick(s.id, s.title, e)}
              className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-hub-hover rounded-lg shrink-0 transition"
            >
              <Trash2 className="w-3 h-3 text-hub-tertiary" />
            </button>
          </div>
        ))}

        {loadState === 'done' && sessions.length === 0 && (
          <p className="text-hub-muted text-sm text-center p-6">No sessions yet</p>
        )}
      </div>

      <div className="p-3 border-t border-hub flex items-center gap-2.5">
        {user && (
          <>
            <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full ring-2 ring-hub-border" />
            <span className="text-sm text-hub-secondary font-medium">{user.username}</span>
          </>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={cancelDelete}>
          <div
            className="bg-hub-raised border border-hub rounded-hub-xl shadow-2xl w-80 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-hub-danger shrink-0" />
              <h3 className="text-sm font-semibold text-hub-primary">Delete Session</h3>
            </div>
            <p className="text-xs text-hub-tertiary mb-4">
              This will permanently delete <strong className="text-hub-secondary">{deleteTarget.title}</strong> and all its messages. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={cancelDelete}
                className="px-4 py-1.5 text-xs font-medium text-hub-secondary hover:bg-hub-hover rounded-md transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-1.5 text-xs font-medium bg-hub-danger text-white rounded-md hover:bg-hub-danger/80 transition"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
