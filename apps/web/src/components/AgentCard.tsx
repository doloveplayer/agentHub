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
    <div className="bg-slate-800/90 border border-slate-700/60 rounded-xl mb-2.5 overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-700/40">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            status === 'running' ? 'bg-green-400 agent-pulse' :
            status === 'done' ? 'bg-green-500' : 'bg-slate-500'
          }`}
        />
        <span className="text-sm font-semibold text-slate-100 truncate">{displayName}</span>
        {toolCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-400 font-medium">{toolCount} tools</span>
        )}
        {status === 'running' && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            className="ml-auto p-1.5 rounded-lg hover:bg-red-900/40 text-red-400 hover:text-red-300 flex-shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center"
            title="Stop agent"
          >
            <Square className="w-3.5 h-3.5" fill="currentColor" />
          </button>
        )}
        {status !== 'running' && (
          <span className="ml-auto text-[10px] text-slate-500 flex-shrink-0 font-medium">{status}</span>
        )}
      </div>

      {/* Activity feed */}
      <div ref={feedRef} className="max-h-52 overflow-y-auto panel-scroll px-2.5 py-1.5 space-y-1 text-[11px] leading-relaxed">
        {recentEvents.length === 0 && status === 'idle' && (
          <p className="text-slate-600 text-center py-2 italic">Waiting for task...</p>
        )}
        {recentEvents.map((ev, i) => (
          <div key={ev.id || i} className={`flex gap-1.5 px-1.5 py-0.5 rounded-md ${
            ev.type === 'thinking' ? 'text-slate-400 italic bg-slate-800/40' :
            ev.type === 'tool_use' ? 'text-purple-300 bg-purple-950/20' :
            ev.type === 'tool_result' ? 'text-emerald-400 bg-emerald-950/20' :
            ev.type === 'subagent_start' ? 'text-blue-300 bg-blue-950/20' :
            ev.type === 'subagent_result' ? 'text-emerald-300 bg-emerald-950/10' :
            'text-slate-400'
          }`}>
            <span className="flex-shrink-0 w-4 text-center">{EVENT_ICONS[ev.type] ?? '·'}</span>
            <span className="min-w-0 break-words">
              {ev.type === 'thinking' && (ev.details.content || 'Thinking...')}
              {ev.type === 'tool_use' && (
                <><span className="font-semibold">{ev.details.toolName}</span>{' '}
                <span className="text-slate-500">{ev.details.inputPreview || ''}</span></>
              )}
              {ev.type === 'tool_result' && (
                <span className="text-slate-400">{ev.details.resultPreview || ev.details.content || ''}</span>
              )}
              {ev.type === 'subagent_start' && (
                <><span className="font-semibold">{ev.details.agentType}</span>{' '}
                <span className="text-slate-500">{ev.details.description || ''}</span></>
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
