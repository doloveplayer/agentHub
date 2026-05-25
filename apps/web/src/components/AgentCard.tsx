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
        className="bg-hub-surface border-hub rounded-hub-lg mb-2 px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-hub-hover transition"
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          status === 'running' ? 'bg-hub-success agent-pulse' :
          status === 'done' ? 'bg-hub-success' : 'bg-hub-muted'
        }`} />
        <span className="text-caption font-medium text-hub-secondary truncate">{displayName}</span>
        <span className="text-[10px] text-hub-muted ml-auto flex-shrink-0">{status}</span>
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
    <div className="bg-hub-surface border-hub rounded-hub-lg mb-2.5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-hub">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            status === 'running' ? 'bg-hub-success agent-pulse' :
            status === 'done' ? 'bg-hub-success' : 'bg-hub-muted'
          }`}
        />
        <span className="text-body font-semibold text-hub-primary truncate">{displayName}</span>
        {lastToken && (
          <span className="text-caption px-1.5 py-0.5 rounded-sm bg-hub-raised text-hub-tertiary font-medium" title={`Input: ${lastToken.input} Output: ${lastToken.output}`}>
            {lastToken.input > 1000 ? `${(lastToken.input / 1000).toFixed(1)}K` : lastToken.input}↑ {lastToken.output > 1000 ? `${(lastToken.output / 1000).toFixed(1)}K` : lastToken.output}↓
          </span>
        )}
        {toolCount > 0 && (
          <span className="text-caption px-1.5 py-0.5 rounded-sm bg-hub-raised text-hub-tertiary font-medium">{toolCount} tools</span>
        )}
        {status === 'running' && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            className="ml-auto p-1.5 rounded-md hover:bg-hub-danger/15 text-hub-danger/80 hover:text-hub-danger flex-shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center transition active:scale-[0.97]"
            title="Stop agent"
          >
            <Square className="w-3.5 h-3.5" fill="currentColor" />
          </button>
        )}
        {status !== 'running' && (
          <span className="ml-auto text-caption text-hub-muted flex-shrink-0 font-medium">{status}</span>
        )}
      </div>

      {/* Task banner */}
      {currentTask && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-hub-accent/10 border-b border-hub-accent/20 text-caption">
          <Wrench className="w-3 h-3 text-hub-accent" />
          <span className="text-hub-accent font-medium truncate">{currentTask.title}</span>
          {taskCount > 0 && (
            <span className="ml-auto text-hub-muted flex-shrink-0">{taskCount} queued</span>
          )}
        </div>
      )}

      {/* Activity feed */}
      <div ref={feedRef} className="max-h-52 overflow-y-auto panel-scroll px-2.5 py-1.5 space-y-1 text-caption leading-relaxed">
        {recentEvents.length === 0 && status === 'idle' && (
          <p className="text-hub-muted text-center py-2 italic">Waiting for task...</p>
        )}
        {recentEvents.map((ev, i) => (
          <div key={ev.id || i} className={`flex gap-1.5 px-1.5 py-0.5 rounded-sm ${
            ev.type === 'thinking' ? 'text-hub-muted italic bg-hub-hover' :
            ev.type === 'tool_use' ? 'text-hub-accent bg-hub-accent/10' :
            ev.type === 'tool_result' ? 'text-hub-success bg-hub-success/10' :
            ev.type === 'subagent_start' ? 'text-hub-link bg-hub-link/10' :
            ev.type === 'subagent_result' ? 'text-hub-success/80 bg-hub-success/8' :
            ev.type === 'permission_request' ? 'text-hub-warning bg-hub-warning/10' :
            'text-hub-muted'
          }`}>
            <span className="flex-shrink-0 w-4 text-center">{EVENT_ICONS[ev.type] ?? '·'}</span>
            <span className="min-w-0 break-words">
              {ev.type === 'thinking' && (ev.details.content || 'Thinking...')}
              {ev.type === 'tool_use' && (
                <><span className="font-semibold">{ev.details.toolName}</span>{' '}
                <span className="text-hub-muted">{ev.details.inputPreview || ''}</span></>
              )}
              {ev.type === 'tool_result' && (
                <span className="text-hub-muted">{ev.details.resultPreview || ev.details.content || ''}</span>
              )}
              {ev.type === 'subagent_start' && (
                <><span className="font-semibold">{ev.details.agentType}</span>{' '}
                <span className="text-hub-muted">{ev.details.description || ''}</span></>
              )}
              {ev.type === 'subagent_result' && (
                <span>{ev.details.agentType} done</span>
              )}
              {ev.type === 'permission_request' && (
                <><span className="font-semibold">{ev.details.tool}</span>
                {ev.details.path && <span className="text-hub-muted"> on {ev.details.path}</span>}</>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
