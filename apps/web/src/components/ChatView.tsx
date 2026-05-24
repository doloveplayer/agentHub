import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { AgentStatusPanel } from './AgentStatusPanel';
import { agentColor } from './AgentMentionPopup';
import { Wrench, FileText, GitBranch, CheckCircle, Shield, ChevronDown, ChevronUp } from 'lucide-react';
import { ConfirmationPanel } from './ConfirmationPanel';
import { DiffCard } from './DiffCard';
import { PreviewFrame } from './PreviewFrame';
import { PPTViewer } from './PPTViewer';
import { DeployCard } from './DeployCard';
import { TestReportCard } from './TestReportCard';
import { SecurityCard } from './SecurityCard';
import { ReviewCard } from './ReviewCard';
import { DeploymentLauncher } from './DeploymentLauncher';
import type { Message, AgentConfig } from '@agenthub/shared';

const EMPTY_MESSAGES: Message[] = [];

/** Renders ConfirmationPanel below a Planner agent's message (DAG lives in sidebar Tasks tab) */
function PlanRenderer({
  planFromMessage, taskPlans, confirmedPlans, setConfirmedPlans, setTaskPlan, confirmPlan,
}: {
  planFromMessage: any;
  taskPlans: Record<string, any[]>;
  confirmedPlans: Set<string>;
  setConfirmedPlans: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTaskPlan: (planId: string, tasks: any[]) => void;
  confirmPlan: (planId: string, tasks: any[]) => void;
}) {
  const unconfirmedPlans = Object.entries(taskPlans).filter(([pid]) =>
    pid.startsWith('plan-') && !confirmedPlans.has(pid)
  );

  return (
    <>
      {unconfirmedPlans.map(([planId, tasks]) => (
        <ConfirmationPanel key={planId}
          tasks={tasks.map((t: any) => ({
            id: t.taskId,
            title: t.title,
            description: t.description || '',
            agentType: t.agentType as any,
            dependsOn: t.dependsOn || [],
            expectedOutput: t.expectedOutput || '',
            priority: t.priority || 'medium',
          }))}
          onConfirm={() => {
            setConfirmedPlans(prev => new Set(prev).add(planId));
            confirmPlan(planId, tasks);
          }}
          onUpdateTask={(taskId, newDescription) => {
            setTaskPlan(planId, tasks.map((t: any) =>
              t.taskId === taskId ? { ...t, description: newDescription } : t));
          }}
          onCancel={() => {
            const newPlans = { ...taskPlans };
            delete newPlans[planId];
            useAppStore.setState({ taskPlans: newPlans });
          }}
        />
      ))}
    </>
  );
}

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
  const taskPlans = useAppStore((s) => s.taskPlans);
  const diffCards = useAppStore((s) => activeSessionId ? (s.diffCards[activeSessionId] ?? []) : []);
  const deploymentCards = useAppStore((s) => activeSessionId ? (s.deploymentCards[activeSessionId] ?? []) : []);
  const testReports = useAppStore((s) => activeSessionId ? (s.testReports[activeSessionId] ?? []) : []);
  const securityReports = useAppStore((s) => activeSessionId ? (s.securityReports[activeSessionId] ?? []) : []);
  const reviewReports = useAppStore((s) => activeSessionId ? (s.reviewReports[activeSessionId] ?? []) : []);
  const setTaskPlan = useAppStore((s) => s.setTaskPlan);
  const { send, stopAgent, respondToPermission, confirmPlan } = useChat(activeSessionId ?? '');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [resolvedPermissions] = useState<Set<string>>(() => new Set());
  const [confirmedPlans, setConfirmedPlans] = useState<Set<string>>(() => new Set());

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
          // Permission requests render as interactive cards with Allow/Deny
          if (ev.type === 'permission_request') {
            const pid = ev.details.permissionId ?? ev.id;
            const resolved = resolvedPermissions.has(pid);
            return (
              <div key={ev.id} className="bg-amber-950/30 border border-amber-700/50 rounded-lg px-4 py-3 my-2">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-4 h-4 text-amber-400" />
                  <span className="text-sm font-medium text-amber-300">Permission Request</span>
                </div>
                <div className="text-xs text-gray-400 space-y-1 mb-3">
                  <div>Tool: <span className="text-gray-300 font-mono">{ev.details.tool ?? 'unknown'}</span></div>
                  {ev.details.path && <div>Path: <span className="text-gray-300 font-mono">{ev.details.path}</span></div>}
                </div>
                {!resolved ? (
                  <div className="flex gap-2">
                    <button
                      onClick={() => { resolvedPermissions.add(pid); respondToPermission(pid, true); }}
                      className="px-4 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs rounded-md font-medium transition"
                    >
                      Allow
                    </button>
                    <button
                      onClick={() => { resolvedPermissions.add(pid); respondToPermission(pid, false); }}
                      className="px-4 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs rounded-md font-medium transition"
                    >
                      Deny
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-gray-500 italic">Response sent</span>
                )}
              </div>
            );
          }

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
        <div className="text-center">
          <p className="text-slate-500 text-lg font-medium mb-1">Select or create a session</p>
          <p className="text-slate-600 text-sm">Choose an existing session or start a new one to begin</p>
        </div>
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
          <div className="px-4 py-2 border-b border-slate-800/60 flex items-center gap-2 bg-slate-900/40">
            <span className="text-[11px] text-slate-500 mr-1 font-medium">Participants</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-900/40 border border-blue-700/50 text-blue-300 font-medium">You</span>
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
              {diffCards.filter((card) => card.agentMessageId === msg.id).map((card) => (
                <DiffCard key={card.id} sessionId={activeSessionId} title={card.title} files={card.files} />
              ))}
              {/* Planner task plan: render after the Planner agent's message */}
              {msg.senderType === 'agent' && msg.agentId && agentMap.get(msg.agentId)?.name === 'planner' && msg.status === 'done' && (
                <PlanRenderer planFromMessage={msg} taskPlans={taskPlans} confirmedPlans={confirmedPlans}
                  setConfirmedPlans={setConfirmedPlans} setTaskPlan={setTaskPlan} confirmPlan={confirmPlan} />
              )}
            </React.Fragment>
          ))}
          {deploymentCards.map((card) => (
            <DeployCard key={card.deploymentId} sessionId={activeSessionId} deployment={card} />
          ))}
          {testReports.map((item) => <TestReportCard key={item.id} report={item.report} />)}
          {securityReports.map((item) => <SecurityCard key={item.id} sessionId={activeSessionId} report={item.report} />)}
          {reviewReports.map((item) => <ReviewCard key={item.id} report={item.report} />)}
          <div ref={bottomRef} />
        </div>
        <PreviewFrame sessionId={activeSessionId} />
        <div className="border-t border-white/10 px-4 py-2">
          <div className="flex flex-wrap items-center gap-3">
            <PPTViewer />
            <DeploymentLauncher sessionId={activeSessionId} />
          </div>
        </div>
        <MessageInput onSend={send} disabled={hasRunningAgent} />
      </div>

      {/* Agent status panel — only for group sessions, hidden on small screens */}
      {activeSession?.type === 'group' && sessionAgents.length > 0 && (
        <div className="hidden lg:block w-72 flex-shrink-0">
          <AgentStatusPanel sessionAgents={sessionAgents} onStopAgent={stopAgent} />
        </div>
      )}
    </div>
  );
}
