import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, MessageSquare, Trash2, Users, X, AlertTriangle, Loader2, RefreshCw, Pencil, ChevronDown, ChevronRight, Bot, Save, Pin, Archive, ArchiveRestore, Search } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { CreateAgentModal } from './CreateAgentModal';
import type { Session, AgentConfig } from '@agenthub/shared';

interface Props { onCloseMobile?: () => void; iconMode?: boolean; onToggleIconMode?: () => void; }

type LoadState = 'loading' | 'error' | 'done';

interface AgentGroup {
  agent: { id: string; name: string; displayName: string };
  sessions: Session[];
}

export function SessionList({ onCloseMobile, iconMode, onToggleIconMode }: Props) {
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
  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Archive
  const [showArchived, setShowArchived] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);

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

  // Track whether we've done the initial message load to avoid re-fetching
  const initialLoadDone = useRef(false);

  useEffect(() => { loadSessions(); }, []);

  // Auto-load messages for restored active session
  useEffect(() => {
    if (loadState === 'done' && activeSessionId && !initialLoadDone.current) {
      initialLoadDone.current = true;
      handleSelect(activeSessionId);
    }
  }, [loadState, activeSessionId]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Sort sessions: pinned first, then by updatedAt desc. Exclude archived from main list.
  const sortedSessions = useMemo(() => {
    return [...sessions]
      .filter((s) => !s.archived)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [sessions]);

  // Search filter helper
  const filterBySearch = (list: Session[], search: string): Session[] => {
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      s.agents?.some((a) => a.displayName.toLowerCase().includes(q))
    );
  };

  // Group solo sessions by agent
  const { soloGroups, groupSessions } = useMemo(() => {
    const soloByAgent = new Map<string, AgentGroup>();
    let groupList: any[] = [];

    for (const s of sortedSessions) {
      if (s.type === 'group') {
        groupList.push(s);
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

    // Apply search filtering
    if (debouncedSearch) {
      groupList = filterBySearch(groupList, debouncedSearch);
      // Filter each agent group's sessions and remove empty groups
      const filteredGroups: AgentGroup[] = [];
      for (const group of soloByAgent.values()) {
        const filtered = filterBySearch(group.sessions, debouncedSearch);
        if (filtered.length > 0) {
          filteredGroups.push({ ...group, sessions: filtered });
        }
      }
      return { soloGroups: filteredGroups, groupSessions: groupList };
    }

    return { soloGroups: Array.from(soloByAgent.values()), groupSessions: groupList };
  }, [sortedSessions, debouncedSearch]);

  // Agent store lookup for inline editing
  const agentMap = useMemo(() => {
    const m = new Map<string, AgentConfig>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const [showCreateAgentModal, setShowCreateAgentModal] = useState(false);

  const handleCreate = async (type: 'group') => {
    const session = await api.createSession({ type: 'group' });
    setSessions([session, ...sessions]);
    api.getAgents().then(setAgents).catch(console.error);
    if (session.permissionMode) {
      setSessionPermissionMode(session.id, session.permissionMode);
    }
    setActiveSession(session.id);
    setShowCreate(false);
  };

  const handleCreateSoloSession = async (agentId: string) => {
    const session = await api.createSession({ type: 'solo', agentIds: [agentId] });
    setSessions([session, ...sessions]);
    if (session.permissionMode) {
      setSessionPermissionMode(session.id, session.permissionMode);
    }
    setActiveSession(session.id);
  };

  const handleSelect = async (id: string) => {
    setActiveSession(id);
    clearUnread(id);
    const session = await api.getSession(id);
    useAppStore.setState((s) => {
      const existingMsgs = s.messages[id] ?? [];
      // Build a map of existing messages by ID to preserve streamed content
      const existingMap = new Map(existingMsgs.map(m => [m.id, m]));
      // Build a set of API message IDs for quick lookup
      const apiMsgIds = new Set(session.messages.map((m: any) => m.id));
      // Merge API messages with existing messages:
      // - Always use API status when it's 'done' or 'error' (authoritative)
      // - Keep existing content if it's non-empty (streamed content may be more complete)
      // - Only keep 'streaming' status if API also says 'streaming'
      const mergedMsgs = session.messages.map((apiMsg: any) => {
        const existing = existingMap.get(apiMsg.id);
        if (existing && existing.content) {
          // Use API status when it's done/error (authoritative), otherwise keep existing
          const status = (apiMsg.status === 'done' || apiMsg.status === 'error')
            ? apiMsg.status
            : existing.status;
          return { ...apiMsg, content: existing.content, status };
        }
        return apiMsg;
      });
      // Append local messages that are not in API response (e.g., temp messages, streaming messages)
      for (const localMsg of existingMsgs) {
        if (!apiMsgIds.has(localMsg.id)) {
          mergedMsgs.push(localMsg);
        }
      }
      return { messages: { ...s.messages, [id]: mergedMsgs } };
    });
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
      // Also remove from archived list if present
      setArchivedSessions(prev => prev.filter(s => s.id !== id));
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

  // --- Pin / Archive handlers ---

  const handleTogglePin = async (sessionId: string, currentPinned: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.updateSession(sessionId, { pinned: !currentPinned });
      useAppStore.getState().updateSessionInList(sessionId, { pinned: !currentPinned });
    } catch { /* ignore */ }
  };

  const handleToggleArchive = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.updateSession(sessionId, { archived: true });
      const state = useAppStore.getState();
      const session = state.sessions.find((s) => s.id === sessionId);
      if (session) {
        state.updateSessionInList(sessionId, { archived: true });
        // Move to archived list locally
        setArchivedSessions((prev) => [{ ...session, archived: true } as Session, ...prev]);
        // If archiving the active session, switch to another one
        if (state.activeSessionId === sessionId) {
          const remaining = state.sessions.filter((s) => s.id !== sessionId && !s.archived);
          setActiveSession(remaining[0]?.id ?? null);
        }
      }
    } catch { /* ignore */ }
  };

  const handleUnarchive = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.updateSession(sessionId, { archived: false });
      // Refresh to pull back into active list with correct sorting
      loadSessions();
    } catch {
      // Session may have been deleted — still remove from archived list below
    }
    setArchivedSessions((prev) => prev.filter((s) => s.id !== sessionId));
  };

  const loadArchivedSessions = async () => {
    if (!archivedLoaded) {
      try {
        const data = await api.getSessions(true);
        setArchivedSessions(data.filter((s: any) => s.archived));
        setArchivedLoaded(true);
      } catch { /* ignore */ }
    }
  };

  // --- Render helpers ---

  const renderSessionRow = (s: any, opts?: { indent?: boolean; icon?: React.ReactNode }) => (
    <div
      key={s.id}
      onClick={() => handleSelect(s.id)}
      className={`${opts?.indent === false ? "" : "ml-5"} mr-1 px-2.5 py-2 cursor-pointer hover:bg-hub-hover rounded-md flex items-center gap-2.5 group transition border-l-[3px] ${activeSessionId === s.id ? "bg-hub-active border-l-hub-accent" : "border-l-transparent"}`}
    >
      {opts?.icon && <span className="shrink-0">{opts.icon}</span>}
      <div className="min-w-0 flex-1">
        {editingSessionId === s.id ? (
          <input
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onBlur={() => handleSaveRenameSession(s.id)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveRenameSession(s.id); if (e.key === "Escape") { setEditingSessionId(null); setEditingTitle(""); } }}
            autoFocus onClick={(e) => e.stopPropagation()}
            className="bg-hub-input border border-hub-accent rounded px-1.5 py-0.5 text-[13px] text-hub-primary w-full outline-none"
          />
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] text-hub-secondary truncate flex-1">{s.title}</span>
            <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition">
              <button onClick={(e) => handleStartRenameSession(s.id, s.title, e)} className="p-0.5 hover:bg-hub-hover rounded" title="Rename"><Pencil className="w-3 h-3 text-hub-tertiary" /></button>
              <button onClick={(e) => handleTogglePin(s.id, !!s.pinned, e)} className={`p-0.5 hover:bg-hub-hover rounded ${s.pinned ? "opacity-100" : ""}`} title={s.pinned ? "Unpin" : "Pin"}><Pin className={`w-3 h-3 ${s.pinned ? "text-hub-accent fill-hub-accent" : "text-hub-tertiary"}`} /></button>
              <button onClick={(e) => handleToggleArchive(s.id, e)} className="p-0.5 hover:bg-hub-hover rounded" title="Archive"><Archive className="w-3 h-3 text-hub-tertiary" /></button>
              <button onClick={(e) => handleDeleteSessionClick(s.id, s.title, e)} className="p-0.5 hover:bg-hub-hover rounded" title="Delete"><Trash2 className="w-3 h-3 text-hub-tertiary" /></button>
            </div>
          </div>
        )}
        {s.lastMessage && (
          <div className="text-[11px] text-hub-tertiary truncate mt-0.5">{s.lastMessage.senderType === "human" ? "You: " : ""}{s.lastMessage.content}</div>
        )}
      </div>
      {(unreadCounts[s.id] || 0) > 0 && activeSessionId !== s.id && (
        <span className="ml-auto bg-hub-accent text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0">{unreadCounts[s.id] > 99 ? "99+" : unreadCounts[s.id]}</span>
      )}
    </div>
  );

  const renderAgentGroup = (group: AgentGroup) => {
    const { agent, sessions: agentSessions } = group;
    const isCollapsed = collapsedAgents.has(agent.id);
    const isEditing = editingAgentId === agent.id;

    return (
      <div key={agent.id}>
        {/* Clean agent header */}
        <button
          onClick={() => toggleAgent(agent.id)}
          className="w-full flex items-center gap-1.5 px-1 py-1 text-xs text-hub-tertiary hover:text-hub-secondary hover:bg-hub-hover/30 rounded transition group"
        >
          {isCollapsed ? <ChevronRight className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
          <Bot className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate flex-1 text-left text-hub-secondary">{agent.displayName}</span>
          <span className="text-[10px] opacity-40 shrink-0">{agentSessions.length}</span>
          <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <button onClick={(e) => handleStartEditAgent(agent.id, e)} className="p-0.5 hover:bg-hub-hover rounded" title="Edit"><Pencil className="w-2.5 h-2.5" /></button>
            <button onClick={(e) => handleDeleteAgentClick(agent.id, agent.displayName, agentSessions.length, e)} className="p-0.5 hover:bg-hub-hover rounded" title="Delete"><Trash2 className="w-2.5 h-2.5" /></button>
          </div>
        </button>

        {/* Inline editor */}
        {isEditing && (
          <div className="px-2 py-2 bg-hub-active/30 border-y border-hub space-y-1.5" onClick={(e) => e.stopPropagation()}>
            <input value={agentEdit.displayName} onChange={(e) => setAgentEdit(prev => ({ ...prev, displayName: e.target.value }))} placeholder="Display Name" className="w-full px-2 py-1 text-[11px] bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent" />
            <input value={agentEdit.description} onChange={(e) => setAgentEdit(prev => ({ ...prev, description: e.target.value }))} placeholder="Description" className="w-full px-2 py-1 text-[11px] bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent" />
            <textarea value={agentEdit.systemPrompt} onChange={(e) => setAgentEdit(prev => ({ ...prev, systemPrompt: e.target.value }))} rows={3} placeholder="System Prompt" className="w-full px-2 py-1 text-[11px] bg-hub-surface border border-hub-border rounded text-hub-primary focus:outline-none focus:border-hub-accent resize-none font-mono" />
            {agentEditError && <div className="text-[10px] text-hub-danger bg-hub-danger/10 px-2 py-1 rounded">{agentEditError}</div>}
            <div className="flex gap-1.5 justify-end">
              <button onClick={handleCancelEditAgent} className="px-2.5 py-1 text-[11px] text-hub-secondary hover:bg-hub-hover rounded transition">Cancel</button>
              <button onClick={() => handleSaveAgent(agent.id)} className="px-2.5 py-1 text-[11px] bg-hub-accent text-white rounded hover:bg-hub-accent-hover transition font-medium flex items-center gap-1"><Save className="w-3 h-3" /> Save</button>
            </div>
          </div>
        )}

        {/* Sessions */}
        {!isCollapsed && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); handleCreateSoloSession(agent.id); }}
              className="w-full text-left px-4 py-1.5 text-xs text-hub-tertiary hover:text-hub-accent hover:bg-hub-hover transition"
            >
              + New Solo Session
            </button>
            {agentSessions.map((s) => renderSessionRow(s))}
          </>
        )}
      </div>
    );
  };

  // Icon-only collapsed sidebar
  if (iconMode) {
    return (
      <div className="w-full h-full bg-hub-sidebar border-r border-hub flex flex-col items-center py-3 gap-1">
        <button onClick={onToggleIconMode} className="p-2 mb-2 hover:bg-hub-hover rounded-lg text-hub-tertiary hover:text-hub-secondary transition" title="Expand (⌘B)">
          <ChevronRight className="w-4 h-4" />
        </button>
        {soloGroups.map((g) => (
          <button key={g.agent.id} onClick={() => handleSelect(g.sessions[0]?.id)} className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-semibold hover:bg-hub-hover transition relative group"
            title={g.agent.displayName || g.agent.name}
            style={{backgroundColor: `hsl(${Math.abs(g.agent.name.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0)) % 360}, 55%, 25%)`}}>
            <span className="text-white text-[11px]">{(g.agent.displayName || g.agent.name)[0]}</span>
            <span className="absolute left-full ml-2 px-2 py-1 bg-hub-raised border border-hub rounded text-xs text-hub-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition pointer-events-none z-50">{g.agent.displayName || g.agent.name}</span>
          </button>
        ))}
        {groupSessions.length > 0 && <div className="w-8 h-px bg-hub-border my-1" />}
        {groupSessions.map((s) => (
          <button key={s.id} onClick={() => handleSelect(s.id)} className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-semibold hover:bg-hub-hover transition relative group ${activeSessionId === s.id ? 'ring-2 ring-hub-accent' : ''}`} title={s.title}>
            <Users className="w-4 h-4 text-hub-tertiary" />
            <span className="absolute left-full ml-2 px-2 py-1 bg-hub-raised border border-hub rounded text-xs text-hub-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition pointer-events-none z-50">{s.title}</span>
          </button>
        ))}
        <div className="mt-auto" />
        <button onClick={onToggleIconMode} className="p-2 hover:bg-hub-hover rounded-lg text-hub-tertiary hover:text-hub-secondary transition" title="Expand (⌘B)">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col bg-hub-sidebar border-r border-hub">
      {/* === Brand Header === */}
      <div className="flex h-12 items-center justify-between px-3">
        <span className="text-[15px] font-semibold text-hub-primary font-serif tracking-tight select-none">AgentHub</span>
        <div className="flex items-center gap-1">
          {onCloseMobile && <button onClick={onCloseMobile} className="md:hidden p-1 hover:bg-hub-hover rounded"><X className="w-4 h-4 text-hub-tertiary" /></button>}
          <button onClick={onToggleIconMode} className="p-1 hover:bg-hub-hover rounded text-hub-tertiary hover:text-hub-secondary transition" title="Collapse (⌘B)">
            <ChevronRight className="w-3.5 h-3.5 rotate-180" />
          </button>
        </div>
      </div>

      {/* === New Session === */}
      <div className="px-2 pb-1">
        <div className="relative">
          <button onClick={() => setShowCreate(!showCreate)} className="p-1.5 hover:bg-hub-hover rounded-hub-lg transition" title="New Session">
            <Plus className="w-4 h-4 text-hub-tertiary" />
          </button>
          {showCreate && (
            <div className="absolute top-full left-0 mt-1 glass-surface-heavy border border-hub rounded-hub-lg shadow-xl z-50 w-56 overflow-hidden">
              <button onClick={() => { setShowCreate(false); setShowCreateAgentModal(true); }} className="w-full text-left px-3 py-2.5 text-[13px] text-hub-secondary hover:bg-hub-hover flex items-center gap-2.5 transition">
                <Bot className="w-3.5 h-3.5" /> Create Agent
              </button>
              <button onClick={() => handleCreate('group')} className="w-full text-left px-3 py-2.5 text-[13px] text-hub-secondary hover:bg-hub-hover flex items-center gap-2.5 transition border-t border-hub">
                <Users className="w-3.5 h-3.5" /> Group Session
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mx-3 h-px bg-hub-border" />

      {/* === Session List === */}
      <div className="flex-1 overflow-y-auto panel-scroll">
        {loadState === 'done' && (
          <div className="px-2.5 py-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hub-tertiary" />
              <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search..." className="w-full pl-8 pr-7 py-1.5 text-xs bg-hub-input border border-hub-border rounded-md text-hub-primary placeholder:text-hub-muted focus:outline-none focus:border-hub-accent transition" />
              {searchQuery && <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-hub-hover rounded"><X className="w-3 h-3 text-hub-tertiary" /></button>}
            </div>
          </div>
        )}

        {loadState === 'loading' && <div className="flex items-center justify-center p-8 gap-2"><Loader2 className="w-4 h-4 text-hub-tertiary animate-spin" /><span className="text-xs text-hub-muted">Loading...</span></div>}
        {loadState === 'error' && (
          <div className="flex flex-col items-center justify-center p-8 gap-2">
            <AlertTriangle className="w-4 h-4 text-hub-warning" /><p className="text-xs text-hub-muted">Failed to load</p>
            <button onClick={loadSessions} className="flex items-center gap-1 px-3 py-1 text-[11px] font-medium text-hub-accent hover:bg-hub-accent/10 rounded-md transition"><RefreshCw className="w-3 h-3" /> Retry</button>
          </div>
        )}
        {loadState === 'done' && sessions.length === 0 && <p className="text-hub-muted text-xs text-center py-8">No sessions yet</p>}

        {loadState === 'done' && (
          <div className="flex flex-col gap-0.5 px-2">
            {soloGroups.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider">Solo</div>
                {soloGroups.map(renderAgentGroup)}
              </>
            )}
            {groupSessions.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider">Group</div>
                {groupSessions.map((s: any) => <div key={s.id}>{renderSessionRow(s, { indent: false, icon: <Users className="w-3.5 h-3.5 text-hub-accent" /> })}</div>)}
              </>
            )}
          </div>
        )}

        {loadState === 'done' && (archivedSessions.length > 0 || archivedLoaded) && (
          <div className="mt-2 px-2">
            <button onClick={() => { setShowArchived(!showArchived); if (!showArchived) loadArchivedSessions(); }} className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider hover:bg-hub-hover/30 rounded transition">
              {showArchived ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Archived
              {archivedSessions.length > 0 && <span className="ml-auto text-[10px] font-normal normal-case">{archivedSessions.length}</span>}
            </button>
            {showArchived && (() => {
              const filtered = debouncedSearch ? archivedSessions.filter((s) => { const q = debouncedSearch.toLowerCase(); return s.title.toLowerCase().includes(q) || s.agents?.some((a: any) => a.displayName.toLowerCase().includes(q)); }) : archivedSessions;
              return filtered.map((s) => (
                <div key={s.id} onClick={() => handleSelect(s.id)} className={`px-3 py-2 cursor-pointer hover:bg-hub-hover flex items-center gap-2 group transition border-l-[3px] ${activeSessionId === s.id ? 'bg-hub-active border-l-hub-accent' : 'border-l-transparent opacity-60'}`}>
                  <span className="text-[13px] text-hub-secondary truncate flex-1">{s.title}</span>
                  <button onClick={(e) => handleUnarchive(s.id, e)} className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-hub-hover rounded transition" title="Unarchive"><ArchiveRestore className="w-3 h-3 text-hub-tertiary" /></button>
                </div>
              ));
            })()}
          </div>
        )}
      </div>

      {/* === Footer === */}
      {user && (
        <div className="p-2 border-t border-hub flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-hub-accent/15 flex items-center justify-center text-xs font-medium text-hub-accent">
            {user.username?.[0]?.toUpperCase() || 'U'}
          </div>
          <span className="text-[13px] text-hub-secondary font-medium truncate">{user.username || 'User'}</span>
        </div>
      )}

      {/* Delete Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={cancelDelete}>
          <div className="glass-surface-heavy border border-hub rounded-hub-xl shadow-2xl w-80 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3"><AlertTriangle className="w-5 h-5 text-hub-danger shrink-0" /><h3 className="text-sm font-semibold text-hub-primary">{deleteTarget.type === 'agent' ? 'Delete Agent' : 'Delete Session'}</h3></div>
            <p className="text-xs text-hub-tertiary mb-4">{deleteTarget.type === 'agent' ? `Delete "${deleteTarget.title}" and all its sessions? This cannot be undone.` : `Delete "${deleteTarget.title}"? This cannot be undone.`}</p>
            <div className="flex justify-end gap-2">
              <button onClick={cancelDelete} className="px-3 py-1.5 text-xs font-medium text-hub-secondary hover:bg-hub-hover rounded-md transition">Cancel</button>
              <button onClick={deleteTarget.type === 'agent' ? confirmDelete : confirmDelete} className="px-3 py-1.5 text-xs font-medium bg-hub-danger text-white rounded-md hover:bg-hub-danger/80 transition">Delete</button>
            </div>
          </div>
        </div>
      )}

      {showCreateAgentModal && (
        <CreateAgentModal
          open={showCreateAgentModal}
          onClose={() => setShowCreateAgentModal(false)}
          onCreated={() => {
            setShowCreateAgentModal(false);
            // Refresh sessions to pick up the new one
            api.getSessions().then(useAppStore.getState().setSessions).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
