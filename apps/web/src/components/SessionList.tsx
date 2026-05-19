import { useEffect, useState } from 'react';
import { Plus, MessageSquare, Trash2, Users } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function SessionList() {
  const { sessions, activeSessionId, setSessions, setActiveSession, user } = useAppStore();
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
    <div className="w-64 h-full bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <h2 className="font-semibold text-white">Sessions</h2>
        <div className="relative">
          <button onClick={() => setShowCreate(!showCreate)} className="p-1 hover:bg-gray-800 rounded" title="New Session">
            <Plus className="w-4 h-4 text-gray-400" />
          </button>
          {showCreate && (
            <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 w-40 overflow-hidden">
              <button onClick={() => handleCreate('solo')} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2">
                <MessageSquare className="w-3.5 h-3.5" /> Solo Session
              </button>
              <button onClick={() => handleCreate('group')} className="w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-2">
                <Users className="w-3.5 h-3.5" /> Group Session
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.map((s: any) => (
          <div
            key={s.id}
            onClick={() => handleSelect(s.id)}
            className={`p-3 cursor-pointer hover:bg-gray-800 flex items-start gap-2 group ${
              activeSessionId === s.id ? 'bg-gray-800' : ''
            }`}
          >
            {s.type === 'group' ? (
              <Users className="w-4 h-4 mt-0.5 text-purple-400 shrink-0" />
            ) : (
              <MessageSquare className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-300 truncate">
                {s.title}
                {s.type === 'group' && s.agents && (
                  <span className="text-[10px] text-gray-500 ml-1">
                    ({s.agents.length} agents)
                  </span>
                )}
              </div>
              {s.lastMessage && (
                <div className="text-xs text-gray-500 truncate">
                  {s.lastMessage.senderType === 'human' ? 'You: ' : ''}{s.lastMessage.content}
                </div>
              )}
            </div>
            <button
              onClick={(e) => handleDelete(s.id, e)}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-700 rounded shrink-0"
            >
              <Trash2 className="w-3 h-3 text-gray-500" />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="text-gray-600 text-sm text-center p-4">No sessions yet</p>
        )}
      </div>
      <div className="p-3 border-t border-gray-800 flex items-center gap-2">
        {user && (
          <>
            <img src={user.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
            <span className="text-sm text-gray-400">{user.login}</span>
          </>
        )}
      </div>
    </div>
  );
}