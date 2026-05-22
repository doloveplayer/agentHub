import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import { TaskCard } from './TaskCard';
import { FileTree } from './FileTree';
import type { AgentConfig } from '@agenthub/shared';
import type { AgentEvent } from '../store/appStore';

const EMPTY_ARR: any[] = [];

interface Props {
  sessionAgents: AgentConfig[];
  onStopAgent?: (agentMessageId: string) => void;
}

type PanelTab = 'Files' | 'Agents' | 'Tasks';

export function AgentStatusPanel({ sessionAgents, onStopAgent }: Props) {
  const [activeTab, setActiveTab] = useState<PanelTab>('Agents');
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

  const tabs: PanelTab[] = ['Files', 'Agents', 'Tasks'];

  return (
    <div className="w-72 apple-panel border-l border-white/[0.06] flex flex-col h-full">
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
      <div className="flex-1 overflow-y-auto panel-scroll p-3">
        {activeTab === 'Agents' && (
          <>
            {agentStates.length === 0 && (
              <p className="text-footnote text-white/25 text-center py-4">No agents in this session</p>
            )}
            {agentStates.map(({ agent, status, events }) => {
              // Find the running message for this agent to pass its ID to onStop
              const runningMsg = messages.find((m) => m.agentId === agent.id && m.status === 'streaming');
              return (
              <AgentCard
                key={agent.id}
                agentId={agent.name}
                displayName={agent.displayName}
                status={status}
                events={events}
                onStop={runningMsg && onStopAgent ? () => onStopAgent(runningMsg.id) : undefined}
              />
              );
            })}
          </>
        )}
        {activeTab === 'Files' && activeSessionId && (
          <FileTree sessionId={activeSessionId} />
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
