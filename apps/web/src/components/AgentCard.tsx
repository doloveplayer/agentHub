import { useEffect, useState } from 'react';
import { Square, Settings, UserPlus } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { FaceBusinessCard, FaceTerminalLog, FaceDashboard, FaceSkillCapabilities } from './AgentCardFaces';
import { AgentAvatar } from './AgentAvatar';
import type { AgentProvider } from '@agenthub/shared';
import { calcContextPct } from '@agenthub/shared/constants';

/** Derive capability tags from agent name / display name. */
function deriveCapabilityTags(agentName?: string, displayName?: string): string[] {
  const name = (agentName || displayName || '').toLowerCase();
  const tags: string[] = [];
  if (name.includes('code')) tags.push('代码生成');
  if (name.includes('review')) tags.push('代码审查');
  if (name.includes('test')) tags.push('测试');
  if (name.includes('planner')) tags.push('任务规划');
  if (name.includes('frontend')) tags.push('前端开发');
  if (name.includes('backend')) tags.push('后端开发');
  if (tags.length === 0) tags.push('通用');
  return tags;
}

/** Get provider info for display. */
function getProviderInfo(provider?: AgentProvider) {
  switch (provider) {
    case 'opencode':
      return { label: 'OpenCode', color: 'bg-blue-500/20 text-blue-400', caps: 'SDK · Session · Stream' };
    case 'claude-code':
    default:
      return { label: 'Claude', color: 'bg-orange-500/20 text-orange-400', caps: 'SDK · Session · Stream' };
  }
}

/** Generate a stable avatar color from a string. Shared across components. */
export function agentAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

interface Props {
  agentId: string;
  displayName: string;
  status: 'running' | 'queued' | 'done' | 'idle';
  events: AgentEvent[];
  onStop?: () => void;
  agentName?: string;
  collapsed?: boolean;
  provider?: AgentProvider;
  onConfigure?: () => void;
  onAddToGroup?: () => void;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  running: { label: '在线', cls: 'bg-hub-success/20 text-hub-success' },
  queued:  { label: '排队中', cls: 'bg-hub-warning/20 text-hub-warning' },
  done:    { label: '完成', cls: 'bg-hub-link/20 text-hub-link' },
  idle:    { label: '空闲', cls: 'bg-hub-muted/20 text-hub-muted' },
};

export function AgentCard({ agentId, displayName, status, events, onStop, agentName, collapsed, provider, onConfigure, onAddToGroup, messages }: Props & { messages?: any[] }) {
  const [activeFace, setActiveFace] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [fading, setFading] = useState(false);
  const inboxCount = useAppStore(s => agentName ? (s.inboxNotifications[agentName] || 0) : 0);

  useEffect(() => {
    if (status === 'running' || status === 'queued') setExpanded(true);
  }, [status]);

  // Clear terminal log on done/idle — only running agents show tool history
  const terminalEvents = status === 'running' ? events : [];

  const capabilityTags = deriveCapabilityTags(agentName, displayName);
  const avatarBg = agentAvatarColor(agentName || displayName);
  const avatarLetter = displayName.charAt(0).toUpperCase();
  const badge = STATUS_BADGE[status] || STATUS_BADGE.idle;
  const providerInfo = getProviderInfo(provider);

  // Model and thinking from agent config in store (needed early for contextPct fallback)
  const agents = useAppStore((s) => s.agents);
  const agentConfig = agents.find((a) => a.name === agentName || a.id === agentId);
  // providerConfig may be a JSON string (Prisma Json type) or an object
  const rawConfig = (agentConfig as any)?.providerConfig;
  const pConfig = typeof rawConfig === 'string' ? (() => { try { return JSON.parse(rawConfig); } catch { return {}; } })() : (rawConfig || {});
  const model = pConfig.model || 'claude-sonnet-4-20250514';
  const thinkingLevel = pConfig.thinking ? 'high' : 'off';

  // Dashboard data - prioritize real-time events, fallback to persisted data
  const tokenEvents = events.filter((e) => e.type === 'token_update');
  const lastToken = tokenEvents.length > 0 ? tokenEvents[tokenEvents.length - 1].details.tokenUsage : null;
  const toolCount = events.filter((e) => e.type === 'tool_use').length;

  // Sum persisted token usage across ALL messages for this agent (robust fallback)
  const agentMessages = (messages || []).filter(m => m.agentId === agentId);
  const persistedInput = agentMessages.reduce((s, m) => s + (m.inputTokens ?? 0), 0);
  const persistedOutput = agentMessages.reduce((s, m) => s + (m.outputTokens ?? 0), 0);
  const persistedCacheRead = agentMessages.reduce((s, m) => s + (m.cacheReadTokens ?? 0), 0);
  const persistedCacheCreate = agentMessages.reduce((s, m) => s + (m.cacheCreateTokens ?? 0), 0);

  // Always take the larger of live events vs persisted DB data.
  // Live events reset per-task, persisted data accumulates across tasks.
  const inputTokens = Math.max(lastToken?.input ?? 0, persistedInput);
  const outputTokens = Math.max(lastToken?.output ?? 0, persistedOutput);
  const liveCache = lastToken ? ((lastToken.cacheRead ?? 0) + (lastToken.cacheCreate ?? 0)) : 0;
  const persistedCache = persistedCacheRead + persistedCacheCreate;
  const cacheTokens = Math.max(liveCache, persistedCache);
  // contextPct: prefer the larger data source; cap at 100%
  const livePct = lastToken?.contextPct ?? 0;
  const persistedPct = persistedInput > 0 ? calcContextPct(persistedInput, model) : 0;
  const rawPct = Math.max(livePct, persistedPct);
  const contextPct = Math.min(100, rawPct);

  // Skills for 4th face — from agent config
  const agentSkills = (agentConfig as any)?.skills || [];

  const isCollapsed = collapsed && !expanded;

  const switchFace = (face: number) => {
    if (face === activeFace) return;
    setFading(true);
    setTimeout(() => {
      setActiveFace(face);
      setFading(false);
    }, 200);
  };

  if (isCollapsed) {
    return (
      <div
        onClick={() => setExpanded(true)}
        className="bg-hub-surface border-hub rounded-hub-lg mb-2 px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-hub-hover transition"
      >
        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0" style={{ backgroundColor: avatarBg }}>{avatarLetter}</div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.cls}`}>{badge.label}</span>
      </div>
    );
  }

  return (
    <div className="bg-hub-surface border-hub rounded-hub-lg mb-2.5 overflow-hidden">
      {/* ---- Fixed Header ---- */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-hub">
        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ backgroundColor: avatarBg }}>{avatarLetter}</div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${providerInfo.color}`}>
          {providerInfo.label}
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${badge.cls}`}>
          {badge.label}
        </span>
        {/* Inbox notification badge */}
        {inboxCount > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-hub-accent/20 text-hub-accent font-bold cursor-pointer hover:bg-hub-accent/30 transition"
            title={`${inboxCount} unread messages from other agents`}
            onClick={(e) => { e.stopPropagation(); useAppStore.getState().clearInboxNotifications(agentName!); }}
          >
            {inboxCount}
          </span>
        )}
        {/* Dot indicators */}
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          {[0, 1, 2, 3].map((face) => (
            <button
              key={face}
              onClick={(e) => { e.stopPropagation(); switchFace(face); }}
              className={`w-2 h-2 rounded-full transition-all ${
                activeFace === face
                  ? 'bg-hub-accent scale-110'
                  : 'bg-hub-muted/30 hover:bg-hub-muted/60'
              }`}
              title={['摘要', '日志', '仪表盘', '能力表'][face]}
            />
          ))}
        </div>
        {onConfigure && (
          <button
            onClick={(e) => { e.stopPropagation(); onConfigure(); }}
            className="p-1 rounded hover:bg-hub-accent/15 text-hub-muted hover:text-hub-accent flex-shrink-0 transition"
            title="Configure"
          >
            <Settings className="w-3 h-3" />
          </button>
        )}
        {onAddToGroup && (
          <button
            onClick={(e) => { e.stopPropagation(); onAddToGroup(); }}
            className="p-1 rounded hover:bg-hub-success/15 text-hub-muted hover:text-hub-success flex-shrink-0 transition"
            title="Add to Group"
          >
            <UserPlus className="w-3 h-3" />
          </button>
        )}
        {(status === 'running' || status === 'queued') && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            className="p-1 rounded hover:bg-hub-danger/15 text-hub-danger/80 flex-shrink-0 transition"
            title="Stop"
          >
            <Square className="w-3 h-3" fill="currentColor" />
          </button>
        )}
      </div>

      {/* ---- Flip Content Area ---- */}
      <div
        className={`transition-all duration-200 ${
          fading ? 'opacity-0 translate-y-1' : 'opacity-100 translate-y-0'
        }`}
      >
        {activeFace === 0 && (
          <FaceBusinessCard
            displayName={displayName}
            description={(agentConfig as any)?.description || ''}
            capabilityTags={capabilityTags}
            agentName={agentName}
            status={status}
            providerCaps={providerInfo.caps}
          />
        )}
        {activeFace === 1 && (
          <FaceTerminalLog events={terminalEvents} />
        )}
        {activeFace === 2 && (
          <FaceDashboard
            model={model}
            contextPct={contextPct}
            inputTokens={inputTokens}
            outputTokens={outputTokens}
            cacheTokens={cacheTokens}
            thinkingLevel={thinkingLevel}
            toolCount={toolCount}
          />
        )}
        {activeFace === 3 && (
          <FaceSkillCapabilities skills={agentSkills} />
        )}
      </div>
    </div>
  );
}
