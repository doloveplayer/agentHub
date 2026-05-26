import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useChat } from '../hooks/useChat';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { AgentStatusPanel } from './AgentStatusPanel';
import { agentColor } from './AgentMentionPopup';
import { Shield } from 'lucide-react';
import { ConfirmationPanel } from './ConfirmationPanel';
import { DiffCard } from './DiffCard';
import { DeployCard } from './DeployCard';
import { TestReportCard } from './TestReportCard';
import { SecurityCard } from './SecurityCard';
import { ReviewCard } from './ReviewCard';
import type { Message, AgentConfig } from '@agenthub/shared';

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_DIFF_CARDS: any[] = [];
const EMPTY_DEPLOYMENT_CARDS: any[] = [];
const EMPTY_TEST_REPORTS: any[] = [];
const EMPTY_SECURITY_REPORTS: any[] = [];
const EMPTY_REVIEW_REPORTS: any[] = [];

/** Renders ConfirmationPanel below a Planner agent's message (DAG lives in sidebar Tasks tab) */
function PlanRenderer({
  planFromMessage, taskPlans, confirmedPlans, setConfirmedPlans, setTaskPlan, confirmPlan,
}: {
  planFromMessage: any;
  taskPlans: Record<string, any[]>;
  confirmedPlans: Set<string>;
  setConfirmedPlans: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTaskPlan: (planId: string, tasks: any[]) => void;
  confirmPlan: (planId: string) => void;
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
            confirmPlan(planId);
          }}
          onUpdateTask={(taskId, newDescription) => {
            setTaskPlan(planId, tasks.map((t: any) =>
              t.taskId === taskId ? { ...t, description: newDescription } : t));
          }}
          onUpdateField={(taskId, field, value) => {
            const resolved = field === 'dependsOn' && typeof value === 'string'
              ? value.split(',').map((s: string) => s.trim()).filter(Boolean)
              : value;
            setTaskPlan(planId, tasks.map((t: any) =>
              t.taskId === taskId ? { ...t, [field]: resolved } : t));
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
  const diffCards = useAppStore((s) => activeSessionId ? (s.diffCards[activeSessionId] ?? EMPTY_DIFF_CARDS) : EMPTY_DIFF_CARDS);
  const deploymentCards = useAppStore((s) => activeSessionId ? (s.deploymentCards[activeSessionId] ?? EMPTY_DEPLOYMENT_CARDS) : EMPTY_DEPLOYMENT_CARDS);
  const testReports = useAppStore((s) => activeSessionId ? (s.testReports[activeSessionId] ?? EMPTY_TEST_REPORTS) : EMPTY_TEST_REPORTS);
  const securityReports = useAppStore((s) => activeSessionId ? (s.securityReports[activeSessionId] ?? EMPTY_SECURITY_REPORTS) : EMPTY_SECURITY_REPORTS);
  const reviewReports = useAppStore((s) => activeSessionId ? (s.reviewReports[activeSessionId] ?? EMPTY_REVIEW_REPORTS) : EMPTY_REVIEW_REPORTS);
  const setTaskPlan = useAppStore((s) => s.setTaskPlan);
  const { send, stopAgent, respondToPermission, confirmPlan } = useChat(activeSessionId ?? '');
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

  const renderAgentInfo = (messageId: string) => {
    const events = agentEvents[messageId];
    if (!events || events.length === 0) return null;

    // Extract token usage from the latest token_update event
    const tokenUpdates = events.filter((ev) => ev.type === 'token_update');
    const lastToken = tokenUpdates[tokenUpdates.length - 1]?.details?.tokenUsage;
    const inputTokens = lastToken?.input ?? 0;
    const outputTokens = lastToken?.output ?? 0;

    // Extract permission requests (still interactive)
    const permissionReqs = events.filter((ev) => ev.type === 'permission_request');

    return (
      <div className="mx-4 my-1 space-y-1">
        {/* Token usage bar */}
        {(inputTokens > 0 || outputTokens > 0) && (
          <div className="flex items-center gap-3 text-[11px] text-hub-tertiary px-1">
            <span title="Input tokens">↑ {formatTokens(inputTokens)}</span>
            <span title="Output tokens">↓ {formatTokens(outputTokens)}</span>
            <span title="Total tokens">Σ {formatTokens(inputTokens + outputTokens)}</span>
          </div>
        )}

        {/* Permission requests render as interactive cards */}
        {permissionReqs.map((ev) => {
          const pid = ev.details.permissionId ?? ev.id;
          const resolved = resolvedPermissions.has(pid);
          return (
            <div key={ev.id} className="bg-hub-warning/10 border border-hub-warning/30 rounded-hub-lg px-4 py-3 my-2">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-4 h-4 text-hub-warning" />
                <span className="text-sm font-medium text-hub-warning">Permission Request</span>
              </div>
              <div className="text-xs text-hub-tertiary space-y-1 mb-3">
                <div>Tool: <span className="text-hub-secondary font-mono">{ev.details.tool ?? 'unknown'}</span></div>
                {ev.details.path && <div>Path: <span className="text-hub-secondary font-mono">{ev.details.path}</span></div>}
              </div>
              {!resolved ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => { resolvedPermissions.add(pid); respondToPermission(pid, true); }}
                    className="px-4 py-1.5 bg-hub-success hover:bg-hub-success/80 text-white text-xs rounded-md font-medium transition"
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => { resolvedPermissions.add(pid); respondToPermission(pid, false); }}
                    className="px-4 py-1.5 bg-hub-danger hover:bg-hub-danger/80 text-white text-xs rounded-md font-medium transition"
                  >
                    Deny
                  </button>
                </div>
              ) : (
                <span className="text-xs text-hub-muted italic">Response sent</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  function formatTokens(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  const hasRunningAgent = activeSessionId ? isSessionStreaming(activeSessionId) : false;
  const { width: panelWidth, onMouseDown: onPanelResize } = useResizablePanel({
    defaultWidth: 288, minWidth: 220, maxWidth: 500, side: 'right',
  });

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-hub-muted">
        <div className="text-center">
          <p className="text-hub-tertiary text-lg font-medium mb-1">Select or create a session</p>
          <p className="text-hub-muted text-sm">Choose an existing session or start a new one to begin</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex h-full">
      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Session header — show participants for group sessions */}
        {activeSession?.type === 'group' && (
          <div className="px-4 py-2 border-b border-hub flex items-center gap-2 bg-hub-surface">
            <span className="text-[11px] text-hub-tertiary mr-1 font-medium">Participants</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-hub-accent/10 border border-hub-accent/30 text-hub-accent font-medium">You</span>
            {sessionAgents.map((a) => (
              <span key={a.id}
                className="text-xs px-2 py-0.5 rounded-full border text-hub-secondary"
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
              {msg.senderType === 'agent' && renderAgentInfo(msg.id)}
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
        <MessageInput onSend={send} disabled={hasRunningAgent} />
      </div>

      {/* Agent status panel — resizable right sidebar */}
      {activeSession?.type === 'group' && sessionAgents.length > 0 && (
        <div className="hidden lg:flex flex-shrink-0" style={{ width: panelWidth }}>
          <div
            onMouseDown={onPanelResize}
            className="w-1 cursor-col-resize hover:bg-hub-accent/60 active:bg-hub-accent transition-colors flex-shrink-0"
            title="拖拽调整宽度"
          >
            <div className="w-4 h-full -ml-1.5" />
          </div>
          <div className="flex-1 min-w-0">
            <AgentStatusPanel sessionAgents={sessionAgents} onStopAgent={stopAgent} />
          </div>
        </div>
      )}
    </div>
  );
}
