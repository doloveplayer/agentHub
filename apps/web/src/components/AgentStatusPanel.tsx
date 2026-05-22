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
    <div className="w-72 bg-slate-900/80 border-l border-slate-800 flex flex-col h-full backdrop-blur-sm">
      <div className="flex border-b border-slate-800/60">
        {tabs.map((tab) => (
          <div
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-center py-2.5 text-xs cursor-pointer border-b-2 font-medium select-none ${
              activeTab === tab
                ? 'text-slate-100 border-purple-500'
                : 'text-slate-500 border-transparent hover:text-slate-300 hover:bg-slate-800/40'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto panel-scroll p-2.5">
        {activeTab === 'Agents' && (
          <>
            {agentStates.length === 0 && (
              <p className="text-xs text-gray-500 text-center py-4">No agents in this session</p>
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
  const plans = Object.entries(taskPlans);
  if (plans.length === 0) {
    return <p className="text-xs text-gray-500 text-center py-4">No active task plans</p>;
  }
  return (
    <div className="space-y-2">
      {plans.map(([planId, tasks]) => (
        <TaskCard key={planId} planId={planId}
          planTitle="Active Plan" summary={`${tasks.length} tasks`} tasks={tasks} />
      ))}
    </div>
  );
}
