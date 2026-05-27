import type { AgentEvent } from '../store/appStore';

// ---- Face 1: Business Card ----
export function FaceBusinessCard({
  displayName,
  description,
  capabilityTags,
  avatarBg,
  avatarLetter,
}: {
  displayName: string;
  description: string;
  capabilityTags: string[];
  avatarBg: string;
  avatarLetter: string;
}) {
  return (
    <div className="flex flex-col items-center py-4 px-3 space-y-3">
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold text-white"
        style={{ backgroundColor: avatarBg }}
      >
        {avatarLetter}
      </div>
      <div className="text-center">
        <h3 className="text-body font-semibold text-hub-primary">{displayName}</h3>
        <p className="text-caption text-hub-tertiary mt-0.5">{description}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-1">
        {capabilityTags.map((tag) => (
          <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-hub-accent/10 text-hub-accent">
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Face 2: Terminal Log ----
export function FaceTerminalLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-hub-muted text-caption italic">
        等待任务...
      </div>
    );
  }

  return (
    <div className="max-h-52 overflow-y-auto panel-scroll p-2 font-mono text-[10px] leading-relaxed space-y-0.5">
      {events.map((ev, i) => {
        const time = ev.timestamp ? new Date(ev.timestamp).toISOString().slice(11, 19) : '--:--:--';
        const details = ev.details || {};
        switch (ev.type) {
          case 'thinking':
            return <div key={i} className="text-hub-muted">{`[${time}] THINK  ${(details.content || '').slice(0, 80)}`}</div>;
          case 'tool_use':
            return <div key={i} className="text-hub-accent">{`[${time}] TOOL   ${details.toolName || '?'} ${details.inputPreview || ''}`}</div>;
          case 'tool_result':
            return <div key={i} className="text-hub-success">{`[${time}] RESULT ${(details.resultPreview || details.content || '').slice(0, 80)}`}</div>;
          case 'subagent_start':
            return <div key={i} className="text-hub-link">{`[${time}] SUBAGENT  ${details.agentType || '?'} started`}</div>;
          case 'subagent_result':
            return <div key={i} className="text-hub-success/80">{`[${time}] SUBAGENT  ${details.agentType || '?'} done`}</div>;
          case 'permission_request':
            return <div key={i} className="text-hub-warning">{`[${time}] PERM   ${details.tool || '?'}`}</div>;
          default:
            return null;
        }
      })}
    </div>
  );
}

// ---- Face 3: Dashboard ----
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function FaceDashboard({
  model,
  contextPct,
  inputTokens,
  outputTokens,
  cacheTokens,
  thinkingLevel,
  toolCount,
}: {
  model: string;
  contextPct: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  thinkingLevel: string;
  toolCount: number;
}) {
  const barColor = contextPct >= 80 ? 'bg-hub-danger' : contextPct >= 50 ? 'bg-hub-warning' : 'bg-hub-success';
  const totalTokens = inputTokens + outputTokens + cacheTokens;
  const inputPct = totalTokens > 0 ? (inputTokens / totalTokens) * 100 : 0;
  const outputPct = totalTokens > 0 ? (outputTokens / totalTokens) * 100 : 0;
  const cachePct = totalTokens > 0 ? (cacheTokens / totalTokens) * 100 : 0;

  return (
    <div className="py-3 px-3 space-y-3 text-[11px]">
      {/* Model */}
      <div className="flex items-center justify-between">
        <span className="text-hub-tertiary">模型</span>
        <span className="text-hub-primary font-medium font-mono">{model}</span>
      </div>

      {/* Context usage */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-hub-tertiary">上下文消耗</span>
          <span className={contextPct > 80 ? 'text-hub-danger' : 'text-hub-primary'}>{contextPct}%</span>
        </div>
        <div className="h-2 bg-hub-raised rounded-full overflow-hidden">
          <div className={`h-full ${barColor} rounded-full transition-all duration-500`} style={{ width: `${Math.min(contextPct, 100)}%` }} />
        </div>
      </div>

      {/* Token usage */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-hub-tertiary">Token 用量</span>
          <span className="text-hub-primary font-mono">{formatTokens(totalTokens)}</span>
        </div>
        <div className="h-2 bg-hub-raised rounded-full overflow-hidden flex">
          <div className="h-full bg-hub-link" style={{ width: `${inputPct}%` }} title={`Input: ${formatTokens(inputTokens)}`} />
          <div className="h-full bg-hub-success" style={{ width: `${outputPct}%` }} title={`Output: ${formatTokens(outputTokens)}`} />
          {cachePct > 0 && <div className="h-full bg-hub-muted" style={{ width: `${cachePct}%` }} title={`Cache: ${formatTokens(cacheTokens)}`} />}
        </div>
        <div className="flex gap-3 mt-1 text-[10px] text-hub-tertiary">
          <span>in {formatTokens(inputTokens)}</span>
          <span>out {formatTokens(outputTokens)}</span>
          {cacheTokens > 0 && <span>cache {formatTokens(cacheTokens)}</span>}
        </div>
      </div>

      {/* Thinking level */}
      <div className="flex items-center justify-between">
        <span className="text-hub-tertiary">思考等级</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
          thinkingLevel === 'high' ? 'bg-hub-accent/20 text-hub-accent' :
          thinkingLevel === 'medium' ? 'bg-hub-warning/20 text-hub-warning' :
          'bg-hub-muted/20 text-hub-muted'
        }`}>{thinkingLevel || 'off'}</span>
      </div>

      {/* Tool count */}
      <div className="flex items-center justify-between text-hub-tertiary">
        <span>工具调用</span>
        <span className="text-hub-primary font-medium">{toolCount} 次</span>
      </div>
    </div>
  );
}
