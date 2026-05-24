import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import { TaskCard } from './TaskCard';
import { FileTree } from './FileTree';
import { VersionTimeline } from './VersionTimeline';
import type { AgentConfig } from '@agenthub/shared';
import type { AgentEvent } from '../store/appStore';

const EMPTY_ARR: any[] = [];

interface Props {
  sessionAgents: AgentConfig[];
  onStopAgent?: (agentMessageId: string) => void;
}

type PanelTab = 'Files' | 'Agents' | 'Tasks';
type ViewMode = 'detailed' | 'aggregated' | 'errors';

export function AgentStatusPanel({ sessionAgents, onStopAgent }: Props) {
  const [activeTab, setActiveTab] = useState<PanelTab>('Agents');
  const [viewMode, setViewMode] = useState<ViewMode>('detailed');
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const agentEvents = useAppStore((s) => s.agentEvents);
  const messages = useAppStore((s) => {
    const sessionId = s.activeSessionId;
    return sessionId ? (s.messages[sessionId] ?? EMPTY_ARR) : EMPTY_ARR;
  });

  const agentStates = sessionAgents.map((agent) => {
    const agentMsgs = messages.filter((m) => m.agentId === agent.id);
    const running = agentMsgs.some((m) => m.status === 'streaming');
    const done = agentMsgs.length > 0 && agentMsgs.every((m) => m.status === 'done');

    let status: 'running' | 'done' | 'idle' = 'idle';
    if (running) status = 'running';
    else if (done) status = 'done';

    const events: AgentEvent[] = [];
    for (const msg of agentMsgs) {
      const evs = agentEvents[msg.id];
      if (evs) events.push(...evs);
    }

    return { agent, status, events };
  });

  // Sort: running → done → idle
  const sortedAgents = [...agentStates].sort((a, b) => {
    const order = { running: 0, done: 1, idle: 2 };
    return (order[a.status] ?? 2) - (order[b.status] ?? 2);
  });

  // Filter for errors-only mode
  const filteredAgents = viewMode === 'errors'
    ? sortedAgents.filter(a => a.events.some(e => e.type === 'permission_request') || a.status !== 'idle')
    : sortedAgents;

  const runningCount = sortedAgents.filter(a => a.status === 'running').length;
  const idleCount = sortedAgents.filter(a => a.status === 'idle').length;
  const runningAgent = sortedAgents.find(a => a.status === 'running');
  const lastToolEvent = runningAgent
    ? (agentEvents[Object.keys(agentEvents).find(k => messages.find(m => m.id === k && m.agentId === runningAgent.agent.id)) ?? ''] ?? [])
        .filter(e => e.type === 'tool_use').slice(-1)[0]
    : null;
  const overviewText = runningAgent
    ? `${runningAgent.agent.displayName} 正在 ${lastToolEvent?.details.toolName || '思考中...'}`
    : (runningCount === 0 ? '全部空闲' : '');

  const tabs: PanelTab[] = ['Files', 'Agents', 'Tasks'];
  const modes: { key: ViewMode; label: string }[] = [
    { key: 'detailed', label: '详细' },
    { key: 'aggregated', label: '聚合' },
    { key: 'errors', label: '异常' },
  ];

  return (
    <div className="w-full apple-panel border-l border-white/[0.06] flex flex-col h-full">
      <div className="flex border-b border-white/[0.06]">
        {tabs.map((tab) => (
          <div
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-center py-2.5 text-footnote cursor-pointer border-b-2 font-medium select-none ${
              activeTab === tab
                ? 'text-white/85 border-accent'
                : 'text-white/25 border-transparent hover:text-white/50 hover:bg-white/[0.04]'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>
      {activeTab === 'Agents' && (
        <>
          {/* View mode toggle + overview */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/[0.04] bg-white/[0.02]">
            <div className="flex gap-0.5 mr-auto">
              {modes.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setViewMode(m.key)}
                  className={`px-2 py-0.5 text-[10px] rounded font-medium transition ${
                    viewMode === m.key
                      ? 'bg-accent/20 text-accent'
                      : 'text-white/25 hover:text-white/50'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-white/30 ml-auto flex-shrink-0">
              {runningCount}/{sortedAgents.length} 运行 · {idleCount} 空闲
            </span>
          </div>
          {/* Overview bar */}
          {viewMode === 'aggregated' && overviewText && (
            <div className="px-3 py-1.5 text-[10px] text-white/35 italic border-b border-white/[0.04] truncate">
              {overviewText}
            </div>
          )}
        </>
      )}
      <div className="flex-1 overflow-y-auto panel-scroll p-3">
        {activeTab === 'Agents' && (
          <>
            {filteredAgents.length === 0 && (
              <p className="text-footnote text-white/25 text-center py-4">
                {viewMode === 'errors' ? 'No errors or active agents' : 'No agents in this session'}
              </p>
            )}
            {filteredAgents.map(({ agent, status, events }) => {
              const runningMsg = messages.find((m) => m.agentId === agent.id && m.status === 'streaming');
              const collapsed = viewMode === 'aggregated' && status === 'idle';
              return (
              <AgentCard
                key={agent.id}
                agentId={agent.name}
                displayName={agent.displayName}
                agentName={agent.name}
                status={status}
                events={events}
                onStop={runningMsg && onStopAgent ? () => onStopAgent(runningMsg.id) : undefined}
                viewMode={viewMode}
                collapsed={collapsed}
              />
              );
            })}
          </>
        )}
        {activeTab === 'Files' && activeSessionId && (
          <div className="space-y-4">
            <FileTree sessionId={activeSessionId} />
            <VersionTimeline sessionId={activeSessionId} />
          </div>
        )}
        {activeTab === 'Tasks' && (
          <ActivePlanView />
        )}
      </div>
    </div>
  );
}

/** Shows the active task plan from the store in the Tasks tab */
function ActivePlanView() {
  const taskPlans = useAppStore((s) => s.taskPlans);
  const planSummaries = useAppStore((s) => s.planSummaries);
  const plans = Object.entries(taskPlans);
  if (plans.length === 0 && Object.keys(planSummaries).length === 0) {
    return <p className="text-footnote text-white/25 text-center py-4">No active task plans</p>;
  }
  return (
    <div className="space-y-2">
      {plans.map(([planId, tasks]) => (
        <div key={planId}>
          <TaskCard planId={planId}
            planTitle="Active Plan" summary={`${tasks.length} tasks`} tasks={tasks} />
          {planSummaries[planId] && (
            <div className="mt-1 px-3 py-2 rounded-md bg-white/[0.04] text-caption">
              <div className="text-white/60 font-medium mb-1">Plan Summary</div>
              <div className="flex gap-3 text-white/40">
                <span className="text-[#30D158]">{planSummaries[planId].completed} done</span>
                {planSummaries[planId].failed > 0 && <span className="text-[#FF453A]">{planSummaries[planId].failed} failed</span>}
                <span>{planSummaries[planId].total - planSummaries[planId].completed - planSummaries[planId].failed} remaining</span>
              </div>
              {planSummaries[planId].fileChanges.length > 0 && (
                <div className="mt-1 text-white/25 truncate">
                  Files: {planSummaries[planId].fileChanges.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
