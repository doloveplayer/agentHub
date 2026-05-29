import React, { useEffect, useMemo, useState } from 'react';
import { Plus, MessageSquare, Trash2, Users, X, AlertTriangle, Loader2, RefreshCw, Pencil, ChevronDown, ChevronRight, Bot, Save } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import type { Session, AgentConfig } from '@agenthub/shared';

interface Props { onCloseMobile?: () => void; }

type LoadState = 'loading' | 'error' | 'done';

interface AgentGroup {
  agent: { id: string; name: string; displayName: string };
  sessions: Session[];
}

export function SessionList({ onCloseMobile }: Props) {
  const { sessions, activeSessionId, setSessions, setActiveSession, setAgents, agents, user, unreadCounts, clearUnread, sessionPermissionModes, setSessionPermissionMode } = useAppStore();
  const [showCreate, setShowCreate] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; type: 'session' | 'agent' } | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [collapsedAgents, setCollapsedAgents] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentEdit, setAgentEdit] = useState({ displayName: '', description: '', systemPrompt: '' });

  const loadSessions = () => {
    setLoadState('loading');
    api.getSessions()
      .then((data) => {
        setSessions(data);
        const modes: Record<string, string> = {};
        for (const s of data) {
          if (s.permissionMode) modes[s.id] = s.permissionMode;
        }
        useAppStore.setState((state) => ({
          sessionPermissionModes: { ...state.sessionPermissionModes, ...modes },
        }));
        setLoadState('done');
        api.getAgents().then(setAgents).catch(console.error);
      })
      .catch(() => {
        setLoadState('error');
      });
  };

  useEffect(() => { loadSessions(); }, []);

  // Group solo sessions by agent
  const { soloGroups, groupSessions } = useMemo(() => {
    const soloByAgent = new Map<string, AgentGroup>();
    const groupSessions: any[] = [];

    for (const s of sessions) {
      if (s.type === 'group') {
        groupSessions.push(s);
        continue;
      }
      const agentInfo = s.agents?.[0];
      const agentId = agentInfo?.agentId || 'unknown';
      if (!soloByAgent.has(agentId)) {
        soloByAgent.set(agentId, {
          agent: agentInfo
            ? { id: agentInfo.agentId, name: agentInfo.name, displayName: agentInfo.displayName }
            : { id: agentId, name: 'unknown', displayName: 'Unknown Agent' },
          sessions: [],
        });
      }
      soloByAgent.get(agentId)!.sessions.push(s);
    }

    return { soloGroups: Array.from(soloByAgent.values()), groupSessions };
  }, [sessions]);

  // Agent store lookup for inline editing
  const agentMap = useMemo(() => {
    const m = new Map<string, AgentConfig>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

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
      api.getAgents().then(setAgents).catch(console.error);
      if (session.permissionMode) setSessionPermissionMode(session.id, session.permissionMode);
      setActiveSession(session.id);
      resetCreate();
      return;
    }
    const session = await api.createSession(type === 'group' ? { type: 'group' } : {});
    setSessions([session, ...sessions]);
    if (type === 'group') {
      api.getAgents().then(setAgents).catch(console.error);
    }
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

  // --- Session rename ---
  const handleStartRenameSession = (id: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(id);
    setEditingTitle(title);
  };

  const handleSaveRenameSession = async (id: string) => {
    const trimmed = editingTitle.trim();
    if (trimmed && trimmed !== sessions.find(s => s.id === id)?.title) {
      try {
        await api.updateSession(id, { title: trimmed });
        useAppStore.getState().updateSessionInList(id, { title: trimmed });
      } catch { /* ignore */ }
    }
    setEditingSessionId(null);
    setEditingTitle('');
  };

  // --- Session delete ---
  const handleDeleteSessionClick = (id: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ id, title, type: 'session' });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { id, type } = deleteTarget;

    if (type === 'agent') {
      // Delete agent: cascade removes solo sessions + removes from groups
      try {
        await api.deleteAgent(id);
        // Remove all solo sessions for this agent from local state
        const remaining = sessions.filter((s) => {
          if (s.type !== 'solo') return true;
          return !(s.agents?.[0]?.agentId === id);
        });
        setSessions(remaining);
        // Refresh agents list
        api.getAgents().then(setAgents).catch(console.error);
        // If active session was deleted, switch to nearest
        if (remaining.length < sessions.length) {
          const deletedSessions = sessions.filter(s => s.type === 'solo' && s.agents?.[0]?.agentId === id);
          if (deletedSessions.some(s => s.id === activeSessionId)) {
            setActiveSession(remaining[0]?.id ?? null);
          }
        }
      } catch (err) {
        console.error('Failed to delete agent:', err);
      }
    } else {
      // Delete single session
      await api.deleteSession(id);
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      if (activeSessionId === id) {
        const idx = sessions.findIndex((s) => s.id === id);
        const next = remaining[Math.min(idx, remaining.length - 1)];
        setActiveSession(next?.id ?? null);
      }
    }
    setDeleteTarget(null);
  };

  const cancelDelete = () => setDeleteTarget(null);

  // --- Agent inline edit ---
  const handleStartEditAgent = (agentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const agent = agentMap.get(agentId);
    if (!agent) return;
    setEditingAgentId(agentId);
    setAgentEdit({
      displayName: agent.displayName || '',
      description: agent.description || '',
      systemPrompt: agent.systemPrompt || '',
    });
  };

  const [agentEditError, setAgentEditError] = useState<string | null>(null);

  const handleSaveAgent = async (agentId: string) => {
    setAgentEditError(null);
    try {
      await api.updateAgent(agentId, {
        displayName: agentEdit.displayName,
        description: agentEdit.description,
        systemPrompt: agentEdit.systemPrompt,
      });
      // Update agents store
      const updated = agents.map(a => a.id === agentId
        ? { ...a, displayName: agentEdit.displayName, description: agentEdit.description, systemPrompt: agentEdit.systemPrompt }
        : a
      );
      setAgents(updated);
      // Update session titles that reference this agent's displayName
      const oldAgent = agentMap.get(agentId);
      if (oldAgent && oldAgent.displayName !== agentEdit.displayName) {
        const updatedSessions = sessions.map(s => {
          if (s.type === 'solo' && s.agents?.[0]?.agentId === agentId) {
            return { ...s, agents: [{ ...s.agents[0], displayName: agentEdit.displayName }] };
          }
          return s;
        });
        setSessions(updatedSessions);
      }
      setEditingAgentId(null);
    } catch (err: any) {
      console.error('Failed to update agent:', err);
      setAgentEditError(err.message || 'Failed to save');
    }
  };

  const handleCancelEditAgent = () => {
    setEditingAgentId(null);
  };

  // --- Agent delete ---
  const handleDeleteAgentClick = (agentId: string, agentName: string, sessionCount: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget({ id: agentId, title: `${agentName} (${sessionCount} sessions)`, type: 'agent' });
  };

  const toggleAgent = (agentId: string) => {
    setCollapsedAgents(prev => {
      const next = new Set(prev);
      next.has(agentId) ? next.delete(agentId) : next.add(agentId);
      return next;
    });
  };

  const toggleSection = (section: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      next.has(section) ? next.delete(section) : next.add(section);
      return next;
    });
  };

  // --- Render helpers ---

  const renderSessionRow = (s: any, opts?: { indent?: boolean; icon?: React.ReactNode }) => (
    <div
      key={s.id}
      onClick={() => handleSelect(s.id)}
      className={`${opts?.indent === false ? 'px-4' : 'pl-8 pr-4'} py-2.5 cursor-pointer hover:bg-hub-hover flex items-start gap-2 group transition-all duration-hub border-l-[3px] ${
        activeSessionId === s.id ? 'bg-hub-active border-l-hub-accent' : 'border-l-transparent'
      }`}
    >
      {opts?.icon && <span className="mt-0.5 shrink-0">{opts.icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-hub-secondary truncate flex items-center gap-1.5">
          {editingSessionId === s.id ? (
            <input
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => handleSaveRenameSession(s.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRenameSession(s.id); if (e.key === 'Escape') { setEditingSessionId(null); setEditingTitle(''); } }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              className="bg-hub-input border border-hub-accent rounded px-1.5 py-0.5 text-[13px] text-hub-primary w-full outline-none"
            />
          ) : (
            <>
              <span className="truncate">{s.title}</span>
              <button
                onClick={(e) => handleStartRenameSession(s.id, s.title, e)}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-hub-hover rounded shrink-0 transition"
                title="Rename"
              >
                <Pencil className="w-3 h-3 text-hub-tertiary" />
              </button>
            </>
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
        onClick={(e) => handleDeleteSessionClick(s.id, s.title, e)}
        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-hub-hover rounded-lg shrink-0 transition"
      >
        <Trash2 className="w-3 h-3 text-hub-tertiary" />
      </button>
    </div>
  );

  const renderAgentGroup = (group: AgentGroup) => {
    const { agent, sessions: agentSessions } = group;
    const isCollapsed = collapsedAgents.has(agent.id);
    const isEditing = editingAgentId === agent.id;
    const fullAgent = agentMap.get(agent.id);

    return (
      <div key={agent.id}>
        {/* Agent header row */}
        <div
          className="px-4 py-2.5 flex items-center gap-2 group hover:bg-hub-hover/50 cursor-pointer select-none"
          onClick={() => toggleAgent(agent.id)}
        >
          {isCollapsed ? (
            <ChevronRight className="w-3.5 h-3.5 text-hub-tertiary shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-hub-tertiary shrink-0" />
          )}
          <Bot className="w-4 h-4 text-hub-accent shrink-0" />
          <span className="text-sm font-medium text-hub-primary truncate flex-1 min-w-0">
            {agent.displayName}
          </span>
          <span className="text-[10px] text-hub-tertiary bg-hub-active px-1.5 py-0.5 rounded-full shrink-0">
            {agentSessions.length}
          </span>
          {/* Agent action buttons — hover */}
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition">
            <button
              onClick={(e) => handleStartEditAgent(agent.id, e)}
              className="p-1 hover:bg-hub-hover rounded transition"
              title="Edit agent"
            >
              <Pencil className="w-3 h-3 text-hub-tertiary" />
            </button>
            <button
              onClick={(e) => handleDeleteAgentClick(agent.id, agent.displayName, agentSessions.length, e)}
              className="p-1 hover:bg-hub-danger/10 rounded transition"
              title="Delete agent"
            >
              <Trash2 className="w-3 h-3 text-hub-tertiary hover:text-hub-danger" />
            </button>
          </div>
        </div>

        {/* Agent inline editor */}
        {isEditing && (
          <div className="px-4 py-3 bg-hub-active/50 border-y border-hub space-y-2" onClick={(e) => e.stopPropagation()}>
            <div>
              <label className="text-[10px] text-hub-tertiary uppercase tracking-wider">Display Name</label>
              <input
                value={agentEdit.displayName}
                onChange={(e) => setAgentEdit(prev => ({ ...prev, displayName: e.target.value }))}
                className="w-full mt-0.5 px-2 py-1 text-xs bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent"
              />
            </div>
            <div>
              <label className="text-[10px] text-hub-tertiary uppercase tracking-wider">Description</label>
              <input
                value={agentEdit.description}
                onChange={(e) => setAgentEdit(prev => ({ ...prev, description: e.target.value }))}
                className="w-full mt-0.5 px-2 py-1 text-xs bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent"
              />
            </div>
            <div>
              <label className="text-[10px] text-hub-tertiary uppercase tracking-wider">System Prompt</label>
              <textarea
                value={agentEdit.systemPrompt}
                onChange={(e) => setAgentEdit(prev => ({ ...prev, systemPrompt: e.target.value }))}
                rows={4}
                className="w-full mt-0.5 px-2 py-1 text-xs bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent resize-none font-mono"
              />
            </div>
            {agentEditError && (
              <div className="text-[11px] text-hub-danger bg-hub-danger/10 px-2 py-1 rounded">
                {agentEditError}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={handleCancelEditAgent}
                className="px-3 py-1 text-[11px] text-hub-secondary hover:bg-hub-hover rounded transition"
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveAgent(agent.id)}
                className="px-3 py-1 text-[11px] bg-hub-accent text-white rounded hover:bg-hub-accent-hover transition font-medium flex items-center gap-1"
              >
                <Save className="w-3 h-3" /> Save
              </button>
            </div>
          </div>
        )}

        {/* Sessions under this agent */}
        {!isCollapsed && agentSessions.map((s) => renderSessionRow(s))}
      </div>
    );
  };

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
            <div className="absolute top-full left-0 mt-1 bg-hub-raised border border-hub rounded-hub-lg shadow-xl z-50 w-72 overflow-hidden">
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

        {loadState === 'done' && sessions.length === 0 && (
          <p className="text-hub-muted text-sm text-center p-6">No sessions yet</p>
        )}

        {loadState === 'done' && (
          <>
            {/* Solo section — grouped by agent */}
            {soloGroups.length > 0 && (
              <div>
                <button
                  onClick={() => toggleSection('solo')}
                  className="w-full px-4 py-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-hub-tertiary hover:bg-hub-hover/30 transition"
                >
                  {collapsedSections.has('solo') ? (
                    <ChevronRight className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                  Solo
                  <span className="ml-auto text-[10px] font-normal normal-case tracking-normal">
                    {soloGroups.reduce((sum, g) => sum + g.sessions.length, 0)}
                  </span>
                </button>
                {!collapsedSections.has('solo') && soloGroups.map(renderAgentGroup)}
              </div>
            )}

            {/* Group section */}
            {groupSessions.length > 0 && (
              <div>
                <button
                  onClick={() => toggleSection('group')}
                  className="w-full px-4 py-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-hub-tertiary hover:bg-hub-hover/30 transition"
                >
                  {collapsedSections.has('group') ? (
                    <ChevronRight className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                  Group
                  <span className="ml-auto text-[10px] font-normal normal-case tracking-normal">
                    {groupSessions.length}
                  </span>
                </button>
                {!collapsedSections.has('group') && groupSessions.map((s: any) => (
                  <React.Fragment key={s.id}>
                    {renderSessionRow(s, { indent: false, icon: <Users className="w-4 h-4 text-hub-accent" /> })}
                  </React.Fragment>
                ))}
              </div>
            )}
          </>
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
              <h3 className="text-sm font-semibold text-hub-primary">
                {deleteTarget.type === 'agent' ? 'Delete Agent' : 'Delete Session'}
              </h3>
            </div>
            <p className="text-xs text-hub-tertiary mb-4">
              {deleteTarget.type === 'agent' ? (
                <>This will permanently delete agent <strong className="text-hub-secondary">{deleteTarget.title}</strong>, all its solo sessions, and remove it from all groups. This action cannot be undone.</>
              ) : (
                <>This will permanently delete <strong className="text-hub-secondary">{deleteTarget.title}</strong> and all its messages. This action cannot be undone.</>
              )}
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
