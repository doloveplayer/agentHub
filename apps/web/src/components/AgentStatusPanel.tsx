import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import type { AgentConfig } from '@agenthub/shared';
import type { AgentEvent } from '../store/appStore';

const EMPTY_ARR: any[] = [];

interface Props {
  sessionAgents: AgentConfig[];
}

type PanelTab = 'Files' | 'Agents' | 'Tasks';

export function AgentStatusPanel({ sessionAgents }: Props) {
  const [activeTab, setActiveTab] = useState<PanelTab>('Agents');
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

    // Estimate context: accumulated content length / ~4 chars per token
    // Show as percentage of 200k context window
    const contentLen = agentMsgs.reduce((sum, m) => sum + m.content.length, 0);
    const estTokens = Math.round(contentLen / 4);
    const contextPct = Math.min(99, Math.round((estTokens / 200000) * 100));
    const contextUsage = running ? `${contextPct}% · ${estTokens.toLocaleString()} tok` : undefined;

    return { agent, status, events, contextUsage };
  });

  const tabs: PanelTab[] = ['Files', 'Agents', 'Tasks'];

  return (
    <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col h-full">
      <div className="flex border-b border-gray-800">
        {tabs.map((tab) => (
          <div
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-center py-2.5 text-xs cursor-pointer border-b-2 ${
              activeTab === tab
                ? 'text-gray-200 border-purple-500'
                : 'text-gray-500 border-transparent hover:text-gray-400'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {activeTab === 'Agents' && (
          <>
            {agentStates.length === 0 && (
              <p className="text-xs text-gray-500 text-center py-4">No agents in this session</p>
            )}
            {agentStates.map(({ agent, status, events, contextUsage }) => (
              <AgentCard
                key={agent.id}
                agentId={agent.name}
                displayName={agent.displayName}
                status={status}
                events={events}
                contextUsage={contextUsage}
              />
            ))}
          </>
        )}
        {activeTab === 'Files' && (
          <p className="text-xs text-gray-500 text-center py-4">File tree coming in Phase 3</p>
        )}
        {activeTab === 'Tasks' && (
          <p className="text-xs text-gray-500 text-center py-4">Task cards coming in Phase 3</p>
        )}
      </div>
    </div>
  );
}
