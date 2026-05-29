import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import { TaskCard } from './TaskCard';
import { FileTree } from './FileTree';
import { VersionTimeline } from './VersionTimeline';
import { PreviewFrame } from './PreviewFrame';
import type { AgentConfig, Message } from '@agenthub/shared';
import type { AgentEvent } from '../store/appStore';

const EMPTY_ARR: Message[] = [];

interface Props {
  sessionAgents: AgentConfig[];
  onStopAgent?: (agentMessageId: string) => void;
  onReplanTask?: (planId: string, taskId: string) => void;
  onPreviewSelection?: (selection: { text: string; rect: { top: number; left: number; width: number; height: number }; url: string } | null) => void;
}

type PanelTab = 'Files' | 'Agents' | 'Tasks' | 'Preview';
type ViewMode = 'detailed' | 'aggregated' | 'errors';

export function AgentStatusPanel({ sessionAgents, onStopAgent, onReplanTask, onPreviewSelection }: Props) {
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
    const queued = agentMsgs.some((m) => m.status === 'queued');
    const done = agentMsgs.length > 0 && agentMsgs.every((m) => m.status === 'done');

    let status: 'running' | 'queued' | 'done' | 'idle' = 'idle';
    if (running) status = 'running';
    else if (queued) status = 'queued';
    else if (done) status = 'done';

    const events: AgentEvent[] = [];
    for (const msg of agentMsgs) {
      const evs = agentEvents[msg.id];
      if (evs) events.push(...evs);
    }

    return { agent, status, events };
  });

  // Sort: running → queued → done → idle
  const sortedAgents = [...agentStates].sort((a, b) => {
    const order = { running: 0, queued: 1, done: 2, idle: 3 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  // Filter for errors-only mode
  const filteredAgents = viewMode === 'errors'
    ? sortedAgents.filter(a => a.events.some(e => e.type === 'permission_request') || a.status !== 'idle')
    : sortedAgents;

  const runningCount = sortedAgents.filter(a => a.status === 'running').length;
  const queuedCount = sortedAgents.filter(a => a.status === 'queued').length;
  const idleCount = sortedAgents.filter(a => a.status === 'idle').length;
  const runningAgent = sortedAgents.find(a => a.status === 'running');
  const lastToolEvent = runningAgent
    ? (agentEvents[Object.keys(agentEvents).find(k => messages.find(m => m.id === k && m.agentId === runningAgent.agent.id)) ?? ''] ?? [])
        .filter(e => e.type === 'tool_use').slice(-1)[0]
    : null;
  const overviewText = runningAgent
    ? `${runningAgent.agent.displayName} 正在 ${lastToolEvent?.details.toolName || '思考中...'}`
    : (queuedCount > 0 ? `${queuedCount} 个 agent 排队中` : (runningCount === 0 ? '全部空闲' : ''));

  const tabs: PanelTab[] = ['Files', 'Agents', 'Tasks', 'Preview'];
  const modes: { key: ViewMode; label: string }[] = [
    { key: 'detailed', label: '详细' },
    { key: 'aggregated', label: '聚合' },
    { key: 'errors', label: '异常' },
  ];

  return (
    <div className="w-full border-l border-hub flex flex-col h-full">
      <div className="flex border-b border-hub">
        {tabs.map((tab) => (
          <div
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-center py-2.5 text-footnote cursor-pointer border-b-2 font-medium select-none ${
              activeTab === tab
                ? 'text-hub-primary border-b-2 border-hub-accent'
                : 'text-hub-muted border-transparent hover:text-hub-secondary hover:bg-hub-hover'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>
      {activeTab === 'Agents' && (
        <>
          {/* View mode toggle + overview */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-hub bg-hub-surface">
            <div className="flex gap-0.5 mr-auto">
              {modes.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setViewMode(m.key)}
                  className={`px-2 py-0.5 text-[10px] rounded font-medium transition ${
                    viewMode === m.key
                      ? 'bg-hub-accent/20 text-hub-accent'
                      : 'text-hub-muted hover:text-hub-secondary'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-hub-muted ml-auto flex-shrink-0">
              {runningCount}/{sortedAgents.length} 运行 · {idleCount} 空闲
            </span>
          </div>
          {/* Overview bar */}
          {viewMode === 'aggregated' && overviewText && (
            <div className="px-3 py-1.5 text-[10px] text-hub-muted italic border-b border-hub truncate">
              {overviewText}
            </div>
          )}
        </>
      )}
      <div className="flex-1 overflow-y-auto panel-scroll p-3">
        {activeTab === 'Agents' && (
          <>
            {filteredAgents.length === 0 && (
              <p className="text-footnote text-hub-muted text-center py-4">
                {viewMode === 'errors' ? 'No errors or active agents' : 'No agents in this session'}
              </p>
            )}
            {filteredAgents.map(({ agent, status, events }) => {
              const runningMsg = messages.find((m) => m.agentId === agent.id && m.status === 'streaming');
              const collapsed = viewMode === 'aggregated' && status === 'idle';
              return (
              <AgentCard
                key={agent.id}
                agentId={agent.id}
                displayName={agent.displayName}
                agentName={agent.name}
                status={status}
                events={events}
                onStop={runningMsg && onStopAgent ? () => onStopAgent(runningMsg.id) : undefined}
                collapsed={collapsed}
                provider={agent.provider}
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
          <ActivePlanView onReplanTask={onReplanTask} />
        )}
        {activeTab === 'Preview' && activeSessionId && (
          <PreviewFrame sessionId={activeSessionId} onSelection={onPreviewSelection} />
        )}
      </div>
    </div>
  );
}

/** Shows the active task plan from the store in the Tasks tab */
function ActivePlanView({ onReplanTask }: { onReplanTask?: (planId: string, taskId: string) => void }) {
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
            planTitle="Active Plan" summary={`${tasks.length} tasks`} tasks={tasks}
            onReplan={onReplanTask ? (taskId: string) => onReplanTask(planId, taskId) : undefined} />
          {planSummaries[planId] && (
            <div className="mt-1 px-3 py-2 rounded-md bg-hub-surface text-caption">
              <div className="text-hub-secondary font-medium mb-1">Plan Summary</div>
              <div className="flex gap-3 text-hub-tertiary">
                <span className="text-hub-success">{planSummaries[planId].completed} done</span>
                {planSummaries[planId].failed > 0 && <span className="text-hub-danger">{planSummaries[planId].failed} failed</span>}
                <span>{planSummaries[planId].total - planSummaries[planId].completed - planSummaries[planId].failed} remaining</span>
              </div>
              {planSummaries[planId].fileChanges.length > 0 && (
                <div className="mt-1 text-hub-muted truncate">
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
