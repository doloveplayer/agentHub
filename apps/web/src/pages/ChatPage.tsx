import { useEffect, useState } from 'react';
import { SessionList } from '../components/SessionList';
import { ChatView } from '../components/ChatView';
import { api } from '../lib/api';
import { useAppStore } from '../store/appStore';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { useAuth } from '../hooks/useAuth';
import { Menu, Settings } from 'lucide-react';
import { SettingsPanel } from '../components/SettingsPanel';

export function ChatPage() {
  // Ensure user profile is loaded when entering with a cached token
  // (without this, user stays null and AddAgentModal filters out all agents)
  useAuth();
  const setAgents = useAppStore((s) => s.setAgents);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [iconMode, setIconMode] = useState(false);
  const { width: sidebarWidth, onMouseDown: onSidebarResize } = useResizablePanel({
    defaultWidth: 256, minWidth: 180, maxWidth: 400, side: 'left',
  });

  // Keyboard shortcut: Cmd/Ctrl+B toggles icon collapse mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setIconMode((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(console.error);
  }, [setAgents]);

  return (
    <div className="h-screen flex bg-hub-root text-hub-primary relative">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setSidebarOpen(false)}>
          <div className="absolute inset-0 bg-hub-root/80" />
          <div className="absolute left-0 top-0 bottom-0 w-72" onClick={e => e.stopPropagation()}>
            <SessionList onCloseMobile={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Desktop sidebar — resizable, with icon collapse support */}
      <div className="hidden md:flex flex-shrink-0" style={{ width: iconMode ? 56 : sidebarWidth }}>
        <SessionList iconMode={iconMode} onToggleIconMode={() => setIconMode((v) => !v)} />
        {!iconMode && (
          <div
            onMouseDown={onSidebarResize}
            className="w-1.5 cursor-col-resize hover:bg-hub-accent/60 active:bg-hub-accent transition-colors flex-shrink-0 group"
            title="拖拽调整宽度"
          >
            <div className="w-4 h-full -ml-1.5" />
          </div>
        )}
      </div>

      {/* Chat area with hamburger menu for mobile */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-hub">
          <button onClick={() => setSidebarOpen(true)} className="p-1.5 rounded-md hover:bg-hub-hover">
            <Menu className="w-5 h-5 text-hub-tertiary" />
          </button>
          <span className="text-sm font-medium text-hub-secondary">AgentHub</span>
          <button onClick={() => setSettingsOpen(true)} className="ml-auto p-1.5 rounded-md hover:bg-hub-hover">
            <Settings className="w-5 h-5 text-hub-tertiary" />
          </button>
        </div>
        <ChatView />
      </div>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
