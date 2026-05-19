import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { AgentStatusPanel } from './AgentStatusPanel';
import { agentColor } from './AgentMentionPopup';
import { Wrench, FileText, GitBranch, CheckCircle, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import type { Message, AgentConfig } from '@agenthub/shared';

const EMPTY_MESSAGES: Message[] = [];

export function ChatView() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const agents = useAppStore((s) => s.agents);

  const messages = useAppStore((s) => {
    if (!activeSessionId) return EMPTY_MESSAGES;
    return s.messages[activeSessionId] ?? EMPTY_MESSAGES;
  });

  const agentEvents = useAppStore((s) => s.agentEvents);
  const isSessionStreaming = useAppStore((s) => s.isSessionStreaming);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { send, stopAgent } = useChat(activeSessionId ?? '');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Agents lookup by id
  const agentMap = new Map<string, AgentConfig>();
  for (const a of agents) agentMap.set(a.id, a);

  // Determine session type and participants
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionAgents: AgentConfig[] = (activeSession as any)?.agents
    ?.map((sa: any) => agentMap.get(sa.agentId))
    .filter(Boolean) ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, agentEvents]);

  const eventIcon = (type: AgentEvent['type']) => {
    const cls = 'w-3.5 h-3.5 shrink-0';
    switch (type) {
      case 'tool_use':        return <Wrench className={cls} />;
      case 'tool_result':     return <FileText className={cls} />;
      case 'subagent_start':  return <GitBranch className={cls} />;
      case 'subagent_result': return <CheckCircle className={cls} />;
      case 'permission_request': return <Shield className={cls} />;
      default: return null;
    }
  };

  const eventLabel = (ev: AgentEvent): string => {
    const d = ev.details;
    const trunc = (s: string | undefined, n: number) =>
      s && s.length > n ? s.slice(0, n) + '…' : s ?? '';

    switch (ev.type) {
      case 'tool_use':
        return `Running: ${d.toolName ?? 'tool'}${d.input ? ' ' + trunc(JSON.stringify(d.input), 60) : ''}`;
      case 'tool_result':
        return `Result: ${trunc(d.content, 80)}`;
      case 'subagent_start':
        return `Sub-agent: ${d.agentType ?? 'unknown'}${d.description ? ' ' + trunc(d.description, 60) : ''}`;
      case 'subagent_result':
        return `Sub-agent done: ${d.agentType ?? 'unknown'}`;
      case 'permission_request':
        return `Permission needed: ${d.tool ?? 'unknown'} on ${d.path ?? 'unknown path'}`;
      default: return '';
    }
  };

  const fullEventContent = (ev: AgentEvent): string => {
    const d = ev.details;
    switch (ev.type) {
      case 'tool_use':
        return d.input ? JSON.stringify(d.input, null, 2) : '(no input)';
      case 'tool_result':
        return d.content ?? '(empty)';
      case 'subagent_start':
        return `Agent type: ${d.agentType ?? 'unknown'}\nDescription: ${d.description ?? 'none'}`;
      case 'subagent_result':
        return `Agent type: ${d.agentType ?? 'unknown'}`;
      case 'permission_request':
        return `Tool: ${d.tool ?? 'unknown'}\nPath: ${d.path ?? 'unknown'}`;
      default: return '';
    }
  };

  const renderAgentEvents = (messageId: string) => {
    const events = agentEvents[messageId];
    if (!events || events.length === 0) return null;
    return (
      <div className="mx-4 my-1 space-y-1">
        {events.map((ev) => {
          const isExpanded = expandedEventId === ev.id;
          return (
            <div key={ev.id}>
              <div
                onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                className="bg-gray-800/50 border border-gray-700 rounded px-3 py-1.5 flex items-center gap-2 text-xs text-gray-400 cursor-pointer hover:bg-gray-800 hover:text-gray-300 transition-colors select-none"
              >
                <span className="text-gray-500">{eventIcon(ev.type)}</span>
                <span className="font-mono truncate">{eventLabel(ev)}</span>
                <span className="ml-auto text-gray-600">
                  {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </span>
              </div>
              {isExpanded && (
                <div className="bg-gray-900/80 border border-gray-700 border-t-0 rounded-b px-4 py-2 mx-0 text-xs">
                  <pre className="text-gray-300 whitespace-pre-wrap break-all font-mono max-h-48 overflow-y-auto">
                    {fullEventContent(ev)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        Select or create a session to start
      </div>
    );
  }

  const hasRunningAgent = isSessionStreaming(activeSessionId);

  return (
    <div className="flex-1 flex h-full">
      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Session header — show participants for group sessions */}
        {activeSession?.type === 'group' && (
          <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2">
            <span className="text-xs text-gray-500 mr-1">Participants:</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/50 border border-blue-700 text-blue-300">You</span>
            {sessionAgents.map((a) => (
              <span key={a.id}
                className="text-xs px-2 py-0.5 rounded-full border text-gray-300"
                style={{ borderColor: agentColor(a.name), backgroundColor: agentColor(a.name) + '20' }}
              >
                {a.displayName}
              </span>
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto chat-scroll">
          {messages.map((msg: any) => (
            <React.Fragment key={msg.id}>
              <MessageBubble
                message={msg}
                isStreaming={msg.status === 'streaming'}
                agentDisplayName={msg.agentId ? agentMap.get(msg.agentId)?.displayName : undefined}
                agentName={msg.agentId ? agentMap.get(msg.agentId)?.name : undefined}
              />
              {msg.senderType === 'agent' && renderAgentEvents(msg.id)}
            </React.Fragment>
          ))}
          <div ref={bottomRef} />
        </div>
        <MessageInput onSend={send} disabled={hasRunningAgent} />
      </div>

      {/* Agent status panel — only for group sessions */}
      {activeSession?.type === 'group' && sessionAgents.length > 0 && (
        <AgentStatusPanel sessionAgents={sessionAgents} onStopAgent={stopAgent} />
      )}
    </div>
  );
}