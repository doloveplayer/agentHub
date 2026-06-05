import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Users, X, AlertTriangle, Loader2, RefreshCw, Pencil, ChevronDown, ChevronRight, Bot, Pin, Archive, ArchiveRestore, Search } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { CreateAgentModal } from './CreateAgentModal';
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
  const setConfigAgentId = useAppStore((s) => s.setConfigAgentId);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
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

  useEffect(() => { loadSessions(); }, []);

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

  // Agent store lookup
  const agentMap = useMemo(() => {
    const m = new Map<string, AgentConfig>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

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
    try {
      const session = await api.getSession(id);
      useAppStore.setState((s) => {
        const existingMsgs = s.messages[id] ?? [];
        const existingMap = new Map(existingMsgs.map(m => [m.id, m]));
        const apiMsgIds = new Set(session.messages.map((m: any) => m.id));
        const mergedMsgs = session.messages.map((apiMsg: any) => {
          const existing = existingMap.get(apiMsg.id);
          if (existing && existing.content) {
            const status = (apiMsg.status === 'done' || apiMsg.status === 'error')
              ? apiMsg.status
              : existing.status;
            return { ...apiMsg, content: existing.content, status };
          }
          return apiMsg;
        });
        for (const localMsg of existingMsgs) {
          if (!apiMsgIds.has(localMsg.id)) {
            mergedMsgs.push(localMsg);
          }
        }
        return { messages: { ...s.messages, [id]: mergedMsgs } };
      });
    } catch {
      // Session may have been deleted or network error — silently fallback
    }
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
              {/* Pin button */}
              <button
                onClick={(e) => handleTogglePin(s.id, !!s.pinned, e)}
                className={`p-0.5 hover:bg-hub-hover rounded shrink-0 transition ${s.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                title={s.pinned ? 'Unpin' : 'Pin'}
              >
                <Pin className={`w-3 h-3 ${s.pinned ? 'text-hub-accent fill-hub-accent' : 'text-hub-tertiary'}`} />
              </button>
              {/* Archive button */}
              <button
                onClick={(e) => handleToggleArchive(s.id, e)}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-hub-hover rounded shrink-0 transition"
                title="Archive"
              >
                <Archive className="w-3 h-3 text-hub-tertiary" />
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
              onClick={(e) => { e.stopPropagation(); setConfigAgentId(agent.id); }}
              className="p-1 hover:bg-hub-hover rounded transition"
              title="Configure agent"
            >
              <Pencil className="w-3 h-3 text-hub-tertiary" />
            </button>
            {agent.name !== 'planner' && !agent.name.startsWith('planner-') && (
              <button
                onClick={(e) => handleDeleteAgentClick(agent.id, agent.displayName, agentSessions.length, e)}
                className="p-1 hover:bg-hub-danger/10 rounded transition"
                title="Delete agent"
              >
                <Trash2 className="w-3 h-3 text-hub-tertiary hover:text-hub-danger" />
              </button>
            )}
          </div>
        </div>

        {/* Sessions under this agent */}
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
              <button onClick={(e) => { e.stopPropagation(); setShowCreateAgent(true); }} className="w-full text-left px-3 py-2 text-sm text-hub-secondary hover:bg-hub-hover transition flex items-center gap-2">
                <Bot className="w-3.5 h-3.5" /> Create Agent
              </button>
              <button onClick={() => handleCreate('group')} className="w-full text-left px-3 py-2 text-sm text-hub-secondary hover:bg-hub-hover transition flex items-center gap-2">
                <Users className="w-3.5 h-3.5" /> Group Session
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto panel-scroll">
        {/* Search bar */}
        {loadState === 'done' && (
          <div className="px-3 py-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hub-tertiary" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search sessions..."
                className="w-full pl-8 pr-7 py-1.5 text-xs bg-hub-input border border-hub-border rounded-md text-hub-primary placeholder:text-hub-muted focus:outline-none focus:border-hub-accent transition"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-hub-hover rounded"
                >
                  <X className="w-3 h-3 text-hub-tertiary" />
                </button>
              )}
            </div>
          </div>
        )}

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

        {/* Archived section */}
        {loadState === 'done' && (archivedSessions.length > 0 || archivedLoaded) && (
          <div>
            <button
              onClick={() => {
                setShowArchived(!showArchived);
                if (!showArchived) loadArchivedSessions();
              }}
              className="w-full px-4 py-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-hub-tertiary hover:bg-hub-hover/30 transition"
            >
              {showArchived ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Archived
              {archivedSessions.length > 0 && (
                <span className="ml-auto text-[10px] font-normal normal-case tracking-normal">
                  {archivedSessions.length}
                </span>
              )}
            </button>
            {showArchived && (() => {
              const filtered = debouncedSearch
                ? archivedSessions.filter((s) => {
                    const q = debouncedSearch.toLowerCase();
                    return s.title.toLowerCase().includes(q) ||
                      s.agents?.some((a) => a.displayName.toLowerCase().includes(q));
                  })
                : archivedSessions;
              if (filtered.length === 0 && archivedSessions.length > 0) {
                return <p className="text-hub-muted text-[11px] text-center py-4">No matching archived sessions</p>;
              }
              return filtered.map((s) => (
                <div
                  key={s.id}
                  onClick={() => handleSelect(s.id)}
                  className={`px-4 py-2.5 cursor-pointer hover:bg-hub-hover flex items-start gap-2 group transition-all duration-hub border-l-[3px] ${
                    activeSessionId === s.id ? 'bg-hub-active border-l-hub-accent' : 'border-l-transparent opacity-60'
                  }`}
                >
                  <Archive className="w-4 h-4 text-hub-tertiary mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-hub-secondary truncate">{s.title}</div>
                    {s.lastMessage && (
                      <div className="text-xs text-hub-tertiary truncate mt-0.5">
                        {s.lastMessage.senderType === 'human' ? 'You: ' : ''}{s.lastMessage.content}
                      </div>
                    )}
                  </div>
                  {/* Unarchive button */}
                  <button
                    onClick={(e) => handleUnarchive(s.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-hub-hover rounded-lg shrink-0 transition"
                    title="Unarchive"
                  >
                    <ArchiveRestore className="w-3 h-3 text-hub-tertiary" />
                  </button>
                  {/* Delete button */}
                  <button
                    onClick={(e) => handleDeleteSessionClick(s.id, s.title, e)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-hub-hover rounded-lg shrink-0 transition"
                  >
                    <Trash2 className="w-3 h-3 text-hub-tertiary" />
                  </button>
                </div>
              ));
            })()}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-hub flex items-center gap-2.5">
        {user && (
          <>
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="w-7 h-7 rounded-full ring-2 ring-hub-border"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-7 h-7 rounded-full ring-2 ring-hub-border bg-hub-surface flex items-center justify-center text-xs text-hub-muted">
                {user.username?.[0]?.toUpperCase() || '?'}
              </div>
            )}
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

      {showCreateAgent && (
        <CreateAgentModal open={showCreateAgent} onClose={() => setShowCreateAgent(false)} />
      )}
    </div>
  );
}
