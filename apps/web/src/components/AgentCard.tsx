import { useEffect, useRef, useState } from 'react';
import { Square, Wrench } from 'lucide-react';
import { agentColor } from './AgentMentionPopup';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';

interface Props {
  agentId: string;
  displayName: string;
  status: 'running' | 'done' | 'idle';
  events: AgentEvent[];
  onStop?: () => void;
  agentName?: string;
  collapsed?: boolean;
  viewMode?: 'detailed' | 'aggregated' | 'errors';
}

const EVENT_ICONS: Record<string, string> = {
  thinking: '💭',
  tool_use: '🔧',
  tool_result: '📋',
  subagent_start: '🔀',
  subagent_result: '✅',
  permission_request: '🔐',
  token_update: '📊',
};

export function AgentCard({ agentId, displayName, status, events, onStop, agentName, collapsed, viewMode }: Props) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (status === 'running') setExpanded(true);
  }, [status]);

  useEffect(() => {
    if (status === 'running' && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events.length, status]);

  const isCollapsed = collapsed && !expanded;

  if (isCollapsed) {
    return (
      <div
        onClick={() => setExpanded(true)}
        className="apple-card mb-2 px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-white/[0.04] transition"
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          status === 'running' ? 'bg-[#30D158] agent-pulse' :
          status === 'done' ? 'bg-[#30D158]' : 'bg-white/[0.15]'
        }`} />
        <span className="text-caption font-medium text-white/60 truncate">{displayName}</span>
        <span className="text-[10px] text-white/25 ml-auto flex-shrink-0">{status}</span>
      </div>
    );
  }

  const recentEvents = events.slice(-20);
  const toolCount = events.filter((e) => e.type === 'tool_use').length;
  const tokenEvents = events.filter((e) => e.type === 'token_update');
  const lastToken = tokenEvents.length > 0 ? tokenEvents[tokenEvents.length - 1].details.tokenUsage : null;
  const currentTask = useAppStore(s => agentName ? s.agentCurrentTask[agentName] : null);
  const taskCount = useAppStore(s => agentName ? (s.agentTaskCounts[agentName] || 0) : 0);

  return (
    <div className="apple-card mb-2.5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-white/[0.06]">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            status === 'running' ? 'bg-[#30D158] agent-pulse' :
            status === 'done' ? 'bg-[#30D158]' : 'bg-white/[0.15]'
          }`}
        />
        <span className="text-body font-semibold text-white/85 truncate">{displayName}</span>
        {lastToken && (
          <span className="text-caption px-1.5 py-0.5 rounded-sm bg-white/[0.06] text-white/30 font-medium" title={`Input: ${lastToken.input} Output: ${lastToken.output}`}>
            {lastToken.input > 1000 ? `${(lastToken.input / 1000).toFixed(1)}K` : lastToken.input}↑ {lastToken.output > 1000 ? `${(lastToken.output / 1000).toFixed(1)}K` : lastToken.output}↓
          </span>
        )}
        {toolCount > 0 && (
          <span className="text-caption px-1.5 py-0.5 rounded-sm bg-white/[0.06] text-white/35 font-medium">{toolCount} tools</span>
        )}
        {status === 'running' && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            className="ml-auto p-1.5 rounded-md hover:bg-[#FF453A]/15 text-[#FF453A]/80 hover:text-[#FF453A] flex-shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center transition active:scale-[0.97]"
            title="Stop agent"
          >
            <Square className="w-3.5 h-3.5" fill="currentColor" />
          </button>
        )}
        {status !== 'running' && (
          <span className="ml-auto text-caption text-white/25 flex-shrink-0 font-medium">{status}</span>
        )}
      </div>

      {/* Task banner */}
      {currentTask && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[#5E5CE6]/8 border-b border-[#5E5CE6]/15 text-caption">
          <Wrench className="w-3 h-3 text-[#5E5CE6]" />
          <span className="text-[#5E5CE6] font-medium truncate">{currentTask.title}</span>
          {taskCount > 0 && (
            <span className="ml-auto text-white/25 flex-shrink-0">{taskCount} queued</span>
          )}
        </div>
      )}

      {/* Activity feed */}
      <div ref={feedRef} className="max-h-52 overflow-y-auto panel-scroll px-2.5 py-1.5 space-y-1 text-caption leading-relaxed">
        {recentEvents.length === 0 && status === 'idle' && (
          <p className="text-white/15 text-center py-2 italic">Waiting for task...</p>
        )}
        {recentEvents.map((ev, i) => (
          <div key={ev.id || i} className={`flex gap-1.5 px-1.5 py-0.5 rounded-sm ${
            ev.type === 'thinking' ? 'text-white/35 italic bg-white/[0.02]' :
            ev.type === 'tool_use' ? 'text-[#5E5CE6] bg-[#5E5CE6]/8' :
            ev.type === 'tool_result' ? 'text-[#30D158] bg-[#30D158]/8' :
            ev.type === 'subagent_start' ? 'text-[#64D2FF] bg-[#64D2FF]/8' :
            ev.type === 'subagent_result' ? 'text-[#30D158]/80 bg-[#30D158]/6' :
            ev.type === 'permission_request' ? 'text-[#FF9F0A] bg-[#FF9F0A]/8' :
            'text-white/35'
          }`}>
            <span className="flex-shrink-0 w-4 text-center">{EVENT_ICONS[ev.type] ?? '·'}</span>
            <span className="min-w-0 break-words">
              {ev.type === 'thinking' && (ev.details.content || 'Thinking...')}
              {ev.type === 'tool_use' && (
                <><span className="font-semibold">{ev.details.toolName}</span>{' '}
                <span className="text-white/25">{ev.details.inputPreview || ''}</span></>
              )}
              {ev.type === 'tool_result' && (
                <span className="text-white/35">{ev.details.resultPreview || ev.details.content || ''}</span>
              )}
              {ev.type === 'subagent_start' && (
                <><span className="font-semibold">{ev.details.agentType}</span>{' '}
                <span className="text-white/25">{ev.details.description || ''}</span></>
              )}
              {ev.type === 'subagent_result' && (
                <span>{ev.details.agentType} done</span>
              )}
              {ev.type === 'permission_request' && (
                <><span className="font-semibold">{ev.details.tool}</span>
                {ev.details.path && <span className="text-white/25"> on {ev.details.path}</span>}</>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
