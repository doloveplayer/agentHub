import { useEffect, useRef, useState } from 'react';
import { Square, Wrench } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';

/** Derive capability tags from agent name / display name. */
function deriveCapabilityTags(agentName?: string, displayName?: string): string[] {
  const name = (agentName || displayName || '').toLowerCase();
  const tags: string[] = [];
  if (name.includes('code') || name.includes('codeagent')) tags.push('代码生成');
  if (name.includes('review')) tags.push('代码审查');
  if (name.includes('test')) tags.push('测试');
  if (name.includes('devops') || name.includes('deploy') || name.includes('devagent')) tags.push('部署运维');
  if (name.includes('planner') || name.includes('main')) tags.push('任务规划');
  if (name.includes('frontend')) tags.push('前端开发');
  if (name.includes('backend')) tags.push('后端开发');
  if (name.includes('deps')) tags.push('依赖管理');
  if (tags.length === 0) tags.push('通用');
  return tags;
}

/** Generate a stable avatar color from a string. */
function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

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

const STATUS_LABELS: Record<string, string> = {
  running: '在线',
  done: '完成',
  idle: '在线',
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

  const capabilityTags = deriveCapabilityTags(agentName, displayName);
  const avatarBg = avatarColor(agentName || displayName);
  const avatarLetter = displayName.charAt(0).toUpperCase();
  const statusLabel = STATUS_LABELS[status] || status;

  const isCollapsed = collapsed && !expanded;

  if (isCollapsed) {
    return (
      <div
        onClick={() => setExpanded(true)}
        className="bg-hub-surface border-hub rounded-hub-lg mb-2 px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-hub-hover transition"
      >
        <div
          className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
          style={{ backgroundColor: avatarBg }}
        >
          {avatarLetter}
        </div>
        <span className="text-caption font-medium text-hub-secondary truncate">{displayName}</span>
        {capabilityTags.slice(0, 2).map(tag => (
          <span key={tag} className="text-[9px] px-1 py-0.5 rounded-sm bg-hub-accent/10 text-hub-accent/80 flex-shrink-0 hidden sm:inline">
            {tag}
          </span>
        ))}
        <span className={`text-[10px] ml-auto flex-shrink-0 font-medium ${
          status === 'running' ? 'text-hub-success' :
          status === 'done' ? 'text-hub-muted' : 'text-hub-tertiary'
        }`}>{statusLabel}</span>
      </div>
    );
  }

  const recentEvents = events.slice(-20);
  const toolCount = events.filter((e) => e.type === 'tool_use').length;
  const tokenEvents = events.filter((e) => e.type === 'token_update');
  const lastToken = tokenEvents.length > 0 ? tokenEvents[tokenEvents.length - 1].details.tokenUsage : null;
  const currentTask = useAppStore(s => agentName ? s.agentCurrentTask[agentName] : null);
  const taskCount = useAppStore(s => agentName ? (s.agentTaskCounts[agentName] || 0) : 0);
  const inboxCount = useAppStore(s => agentName ? (s.inboxNotifications[agentName] || 0) : 0);

  return (
    <div className="bg-hub-surface border-hub rounded-hub-lg mb-2.5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-hub">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
          style={{ backgroundColor: avatarBg }}
          title={displayName}
        >
          {avatarLetter}
        </div>
        <span className="text-body font-semibold text-hub-primary truncate">{displayName}</span>
        {/* Capability tags */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {capabilityTags.map(tag => (
            <span key={tag} className="text-[9px] px-1 py-0.5 rounded-sm bg-hub-accent/10 text-hub-accent/80">
              {tag}
            </span>
          ))}
        </div>
        {inboxCount > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-hub-accent/20 text-hub-accent font-bold cursor-pointer hover:bg-hub-accent/30 transition"
            title={`${inboxCount} unread messages from other agents`}
            onClick={(e) => { e.stopPropagation(); useAppStore.getState().clearInboxNotifications(agentName!); }}
          >
            {inboxCount}
          </span>
        )}
        {lastToken && lastToken.contextPct !== undefined && lastToken.contextPct > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-hub-raised text-hub-tertiary font-medium" title={`Context: ${lastToken.contextPct}% (${lastToken.input} tokens)`}>
            ctx {lastToken.contextPct}%
          </span>
        )}
        {lastToken && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-hub-raised text-hub-tertiary font-medium" title={`Input: ${lastToken.input} Output: ${lastToken.output}`}>
            {lastToken.input > 1000 ? `${(lastToken.input / 1000).toFixed(1)}K` : lastToken.input}↑ {lastToken.output > 1000 ? `${(lastToken.output / 1000).toFixed(1)}K` : lastToken.output}↓
          </span>
        )}
        {toolCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-hub-raised text-hub-tertiary font-medium">{toolCount} tools</span>
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
          <span className={`ml-auto text-caption flex-shrink-0 font-medium ${
            status === 'done' ? 'text-hub-muted' : 'text-hub-tertiary'
          }`}>{statusLabel}</span>
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
      <div ref={feedRef} className="max-h-52 overflow-y-auto panel-scroll px-2.5 py-1.5 space-y-0.5 text-[10px] leading-relaxed">
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
