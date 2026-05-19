import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import type { AgentConfig } from '@agenthub/shared';
import type { AgentEvent } from '../store/appStore';

interface Props {
  sessionAgents: AgentConfig[];
}

const EMPTY_ARR: any[] = [];

export function AgentStatusPanel({ sessionAgents }: Props) {
  const agentEvents = useAppStore((s) => s.agentEvents);
  const messages = useAppStore((s) => {
    const sessionId = s.activeSessionId;
    return sessionId ? (s.messages[sessionId] ?? EMPTY_ARR) : EMPTY_ARR;
  });

  // For each session agent, determine status and collect events
  const agentStates = sessionAgents.map((agent) => {
    const agentMsgs = messages.filter((m) => m.agentId === agent.id);
    const running = agentMsgs.some((m) => m.status === 'streaming');
    const done = agentMsgs.length > 0 && agentMsgs.every((m) => m.status === 'done');

    let status: 'running' | 'done' | 'idle' = 'idle';
    if (running) status = 'running';
    else if (done) status = 'done';

    // Collect events for all agent messages
    const events: AgentEvent[] = [];
    for (const msg of agentMsgs) {
      const evs = agentEvents[msg.id];
      if (evs) events.push(...evs);
    }

    return { agent, status, events };
  });

  return (
    <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col h-full">
      <div className="flex border-b border-gray-800">
        {['Files', 'Agents', 'Tasks'].map((tab) => (
          <div
            key={tab}
            className={`flex-1 text-center py-2.5 text-xs cursor-pointer border-b-2 ${
              tab === 'Agents'
                ? 'text-gray-200 border-purple-500'
                : 'text-gray-500 border-transparent hover:text-gray-400'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {agentStates.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-4">No agents in this session</p>
        )}
        {agentStates.map(({ agent, status, events }) => (
          <AgentCard
            key={agent.id}
            agentId={agent.name}
            displayName={agent.displayName}
            status={status}
            events={events}
          />
        ))}
      </div>
    </div>
  );
}