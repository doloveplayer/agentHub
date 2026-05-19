import { useEffect } from 'react';
import { SessionList } from '../components/SessionList';
import { ChatView } from '../components/ChatView';
import { api } from '../lib/api';
import { useAppStore } from '../store/appStore';

export function ChatPage() {
  const setAgents = useAppStore((s) => s.setAgents);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(console.error);
  }, [setAgents]);

  return (
    <div className="h-screen flex bg-gray-950 text-white">
      <SessionList />
      <ChatView />
    </div>
  );
}
