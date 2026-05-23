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
    <div className="w-full h-full bg-slate-900/80 border-r border-slate-800 flex flex-col backdrop-blur-sm">
      <div className="p-4 border-b border-slate-800/60 flex items-center justify-between">
        <h2 className="font-semibold text-slate-100">Sessions</h2>
        {onCloseMobile && (
          <button onClick={onCloseMobile} className="md:hidden p-1 hover:bg-white/[0.08] rounded">
            <X className="w-4 h-4 text-white/50" />
          </button>
        )}
        <div className="relative">
          <button onClick={() => setShowCreate(!showCreate)} className="p-1.5 hover:bg-slate-800 rounded-lg transition" title="New Session">
            <Plus className="w-4 h-4 text-slate-400" />
          </button>
          {showCreate && (
            <div className="absolute top-full right-0 mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-xl z-50 w-40 overflow-hidden">
              <button onClick={() => handleCreate('solo')} className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700/50 flex items-center gap-2 transition font-medium">
                <MessageSquare className="w-3.5 h-3.5" /> Solo Session
              </button>
              <button onClick={() => handleCreate('group')} className="w-full text-left px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700/50 flex items-center gap-2 transition font-medium">
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
            className={`px-4 py-3 cursor-pointer hover:bg-slate-800/50 flex items-start gap-2.5 group transition border-l-2 ${
              activeSessionId === s.id ? 'bg-slate-800/60 border-l-purple-500' : 'border-l-transparent'
            }`}
          >
            {s.type === 'group' ? (
              <Users className="w-4 h-4 mt-0.5 text-purple-400 shrink-0" />
            ) : (
              <MessageSquare className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-300 truncate flex items-center gap-1.5">
                <span className="truncate">{s.title}</span>
                {s.type === 'group' && s.agents && (
                  <span className="text-[10px] text-gray-500 shrink-0">
                    ({s.agents.length})
                  </span>
                )}
                {(unreadCounts[s.id] || 0) > 0 && activeSessionId !== s.id && (
                  <span className="ml-auto bg-purple-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0">
                    {unreadCounts[s.id] > 99 ? '99+' : unreadCounts[s.id]}
                  </span>
                )}
              </div>
              {s.lastMessage && (
                <div className="text-xs text-slate-500 truncate mt-0.5">
                  {s.lastMessage.senderType === 'human' ? 'You: ' : ''}{s.lastMessage.content}
                </div>
              )}
            </div>
            <button
              onClick={(e) => handleDelete(s.id, e)}
              className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-slate-700 rounded-lg shrink-0 transition"
            >
              <Trash2 className="w-3 h-3 text-slate-500" />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="text-slate-600 text-sm text-center p-6">No sessions yet</p>
        )}
      </div>
      <div className="p-3 border-t border-slate-800/60 flex items-center gap-2.5">
        {user && (
          <>
            <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full ring-2 ring-slate-700" />
            <span className="text-sm text-slate-400 font-medium">{user.login}</span>
          </>
        )}
      </div>
    </div>
  );
}