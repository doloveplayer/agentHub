import { useEffect, useRef } from 'react';
import { Square } from 'lucide-react';
import { agentColor } from './AgentMentionPopup';
import type { AgentEvent } from '../store/appStore';

interface Props {
  agentId: string;
  displayName: string;
  status: 'running' | 'done' | 'idle';
  events: AgentEvent[];
  onStop?: () => void;
}

const EVENT_ICONS: Record<string, string> = {
  thinking: '💭',   // 💭
  tool_use: '🔧',   // 🔧
  tool_result: '📋', // 📋
  subagent_start: '🔀', // 🔀
  subagent_result: '✅',   // ✅
};

export function AgentCard({ agentId, displayName, status, events, onStop }: Props) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll activity feed to bottom while running
  useEffect(() => {
    if (status === 'running' && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events.length, status]);

  // Show last 20 events in reverse (newest at bottom)
  const recentEvents = events.slice(-20);
  const toolCount = events.filter((e) => e.type === 'tool_use').length;

  return (
    <div className="bg-gray-800/80 border border-gray-700 rounded-lg mb-2 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700/50">
        <span
          className={`w-2 h-2 rounded-full ${
            status === 'running' ? 'bg-green-500 animate-pulse' :
            status === 'done' ? 'bg-green-500' : 'bg-gray-500'
          }`}
        />
        <span className="text-sm font-medium text-gray-200 truncate">{displayName}</span>
        {toolCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{toolCount} tools</span>
        )}
        {status === 'running' && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            className="ml-auto p-1 rounded hover:bg-red-900/50 text-red-400 hover:text-red-300 transition flex-shrink-0"
            title="Stop agent"
          >
            <Square className="w-3 h-3" />
          </button>
        )}
        {status !== 'running' && (
          <span className="ml-auto text-[10px] text-gray-500 flex-shrink-0">{status}</span>
        )}
      </div>

      {/* Activity feed */}
      <div ref={feedRef} className="max-h-48 overflow-y-auto px-3 py-1.5 space-y-1 text-[11px] leading-relaxed">
        {recentEvents.length === 0 && status === 'idle' && (
          <p className="text-gray-600 text-center py-1">Waiting for task...</p>
        )}
        {recentEvents.map((ev, i) => (
          <div key={ev.id || i} className={`flex gap-1.5 ${
            ev.type === 'thinking' ? 'text-gray-400 italic' :
            ev.type === 'tool_use' ? 'text-purple-300' :
            ev.type === 'tool_result' ? 'text-green-400' :
            ev.type === 'subagent_start' ? 'text-blue-300' :
            ev.type === 'subagent_result' ? 'text-green-300' :
            'text-gray-400'
          }`}>
            <span className="flex-shrink-0">{EVENT_ICONS[ev.type] ?? '·'}</span>
            <span className="min-w-0 break-words">
              {ev.type === 'thinking' && (ev.details.content || '...')}
              {ev.type === 'tool_use' && (
                <><span className="font-medium">{ev.details.toolName}</span>{' '}
                <span className="text-gray-500">{ev.details.inputPreview || ''}</span></>
              )}
              {ev.type === 'tool_result' && (
                <span className="text-gray-500">{ev.details.resultPreview || ev.details.content || ''}</span>
              )}
              {ev.type === 'subagent_start' && (
                <><span className="font-medium">{ev.details.agentType}</span>{' '}
                <span className="text-gray-500">{ev.details.description || ''}</span></>
              )}
              {ev.type === 'subagent_result' && (
                <span>{ev.details.agentType} done</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
