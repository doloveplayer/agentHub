import { useEffect, useState } from 'react';
import { Plus, MessageSquare, Trash2, Users, X } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

interface Props { onCloseMobile?: () => void; }

export function SessionList({ onCloseMobile }: Props) {
  const { sessions, activeSessionId, setSessions, setActiveSession, user, unreadCounts, clearUnread } = useAppStore();
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    api.getSessions().then(setSessions).catch(console.error);
  }, [setSessions]);

  const handleCreate = async (type: 'solo' | 'group') => {
    const session = await api.createSession(type === 'group' ? { type: 'group' } : {});
    setSessions([session, ...sessions]);
    setActiveSession(session.id);
    setShowCreate(false);
  };

  const handleSelect = async (id: string) => {
    setActiveSession(id);
    clearUnread(id);
    const session = await api.getSession(id);
    useAppStore.setState((s) => ({
      messages: { ...s.messages, [id]: session.messages },
    }));
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteSession(id);
    setSessions(sessions.filter((s) => s.id !== id));
    if (activeSessionId === id) setActiveSession(sessions[0]?.id ?? null);
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
            <div className="absolute top-full right-0 mt-1 bg-hub-raised border border-hub rounded-hub-lg shadow-xl z-50 w-40 overflow-hidden">
              <button onClick={() => handleCreate('solo')} className="w-full text-left px-4 py-2.5 text-sm text-hub-secondary hover:bg-hub-hover flex items-center gap-2 transition font-medium">
                <MessageSquare className="w-3.5 h-3.5" /> Solo Session
              </button>
              <button onClick={() => handleCreate('group')} className="w-full text-left px-4 py-2.5 text-sm text-hub-secondary hover:bg-hub-hover flex items-center gap-2 transition font-medium">
                <Users className="w-3.5 h-3.5" /> Group Session
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto panel-scroll">
        {sessions.map((s: any) => (
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
                <span className="truncate">{s.title}</span>
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
              onClick={(e) => handleDelete(s.id, e)}
              className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-hub-hover rounded-lg shrink-0 transition"
            >
              <Trash2 className="w-3 h-3 text-hub-tertiary" />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="text-hub-muted text-sm text-center p-6">No sessions yet</p>
        )}
      </div>
      <div className="p-3 border-t border-hub flex items-center gap-2.5">
        {user && (
          <>
            <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full ring-2 ring-hub-border" />
            <span className="text-sm text-hub-secondary font-medium">{user.login}</span>
          </>
        )}
      </div>
    </div>
  );
}
