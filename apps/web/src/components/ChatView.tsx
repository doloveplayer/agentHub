import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { useChat } from '../hooks/useChat';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { MessageActions } from './MessageActions';
import { AgentStatusPanel } from './AgentStatusPanel';
import { QuoteToolbar } from './QuoteToolbar';
import { agentColor } from './AgentMentionPopup';
import { Shield, AlertTriangle, ChevronDown, Lock, Eye, Sparkles, Zap, Settings, Plus, Minus } from 'lucide-react';
import { ConfirmationPanel } from './ConfirmationPanel';
import { SettingsPanel } from './SettingsPanel';
import { AddAgentModal } from './AddAgentModal';
import { RemoveAgentModal } from './RemoveAgentModal';
import { DiffCard } from './DiffCard';
import { DeployCard } from './DeployCard';
import { TestReportCard } from './TestReportCard';
import { ReviewCard } from './ReviewCard';
import type { Message, AgentConfig } from '@agenthub/shared';
import { safeContent, formatTokens } from '../lib/text';

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_DIFF_CARDS: any[] = [];
const EMPTY_DEPLOYMENT_CARDS: any[] = [];
const EMPTY_TEST_REPORTS: any[] = [];
const EMPTY_REVIEW_REPORTS: any[] = [];

/** Renders ConfirmationPanel below a Planner agent's message (DAG lives in sidebar Tasks tab) */
function PlanRenderer({
  planFromMessage, taskPlans, confirmedPlans, setConfirmedPlans, setTaskPlan, confirmPlan, renderedPlanIds,
}: {
  planFromMessage: any;
  taskPlans: Record<string, any[]>;
  confirmedPlans: Set<string>;
  setConfirmedPlans: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTaskPlan: (planId: string, tasks: any[]) => void;
  confirmPlan: (planId: string) => void;
  renderedPlanIds: React.MutableRefObject<Set<string>>;
}) {
  const unconfirmedPlans = Object.entries(taskPlans).filter(([pid]) => {
    if (!pid.startsWith('plan-') || confirmedPlans.has(pid)) return false;
    if (renderedPlanIds.current.has(pid)) return false; // already rendered by another PlanRenderer instance
    renderedPlanIds.current.add(pid);
    return true;
  });

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
  const reviewReports = useAppStore((s) => activeSessionId ? (s.reviewReports[activeSessionId] ?? EMPTY_REVIEW_REPORTS) : EMPTY_REVIEW_REPORTS);
  const setTaskPlan = useAppStore((s) => s.setTaskPlan);
  const { send, ensureConnection, stopAgent, respondToPermission, confirmPlan, deleteMessage, regenerate, sendReplan } = useChat(activeSessionId ?? '');
  const addToast = useAppStore((s) => s.addToast);
  const [resolvedPermissions, setResolvedPermissions] = useState<Set<string>>(() => new Set());
  const [confirmedPlans, setConfirmedPlans] = useState<Set<string>>(() => new Set());
  const renderedPlanIds = useRef(new Set<string>());

  // Agents lookup by id
  const agentMap = new Map<string, AgentConfig>();
  for (const a of agents) agentMap.set(a.id, a);

  // Determine session type and participants
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionAgents: AgentConfig[] = (activeSession as any)?.agents
    ?.map((sa: any) => agentMap.get(sa.agentId) ?? {
      id: sa.agentId,
      name: sa.name,
      displayName: sa.displayName,
      description: '',
      systemPrompt: '',
    } as AgentConfig)
    ?? [];

  // @mention agents: in group mode, restrict to session members; in solo, show all
  const mentionableAgents = useMemo(() => {
    if (!activeSession || activeSession.type !== 'group') {
      return agents;
    }
    const sessionAgentIds = new Set(
      ((activeSession as any)?.agents || []).map((sa: any) => sa.agentId)
    );
    return agents.filter((a) => sessionAgentIds.has(a.id));
  }, [activeSession, agents]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, agentEvents]);

  const renderAgentInfo = (messageId: string, isStreaming: boolean) => {
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
            <div key={ev.id} ref={(el) => {
              if (el && !resolved && isStreaming) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }} className="bg-hub-warning/10 border border-hub-warning/30 rounded-hub-lg px-4 py-3 my-2 animate-pulse">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="w-4 h-4 text-hub-warning" />
                <span className="text-sm font-medium text-hub-warning">Permission Request</span>
              </div>
              <div className="text-xs text-hub-tertiary space-y-1 mb-3">
                <div>Tool: <span className="text-hub-secondary font-mono">{ev.details.tool ?? 'unknown'}</span></div>
                {ev.details.path && <div>Path: <span className="text-hub-secondary font-mono">{ev.details.path}</span></div>}
              </div>
              {!resolved && isStreaming ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => { const next = new Set(resolvedPermissions); next.add(pid); setResolvedPermissions(next); respondToPermission(pid, true); }}
                    className="px-4 py-1.5 bg-hub-success hover:bg-hub-success/80 text-white text-xs rounded-md font-medium transition"
                  >
                    Allow
                  </button>
                  <button
                    onClick={() => { const next = new Set(resolvedPermissions); next.add(pid); setResolvedPermissions(next); respondToPermission(pid, false); }}
                    className="px-4 py-1.5 bg-hub-danger hover:bg-hub-danger/80 text-white text-xs rounded-md font-medium transition"
                  >
                    Deny
                  </button>
                </div>
              ) : (
                <span className="text-xs text-hub-muted italic">
                  {resolved ? 'Response sent' : 'Agent terminated — request expired'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const sessionPermissionModes = useAppStore((s) => s.sessionPermissionModes);
  const setSessionPermissionMode = useAppStore((s) => s.setSessionPermissionMode);
  const updateSessionInList = useAppStore((s) => s.updateSessionInList);
  const [showPermDropdown, setShowPermDropdown] = useState(false);
  const [showTrustWarning, setShowTrustWarning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showAddAgents, setShowAddAgents] = useState(false);
  const [showRemoveAgents, setShowRemoveAgents] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<{
    text: string;
    rect: { top: number; left: number; width: number; height: number };
    url: string;
  } | null>(null);

  const getPermissionMode = (): string => {
    if (!activeSessionId) return 'ask';
    return sessionPermissionModes[activeSessionId] ?? (activeSession as any)?.permissionMode ?? 'ask';
  };

  const permissionMode = getPermissionMode();

  const handleChangePermissionMode = async (mode: string) => {
    if (!activeSessionId) return;
    setShowPermDropdown(false);

    if (mode === 'trust') {
      setShowTrustWarning(true);
      return;
    }

    await applyPermissionMode(mode);
  };

  const applyPermissionMode = async (mode: string) => {
    if (!activeSessionId) return;
    try {
      await api.updateSession(activeSessionId, { permissionMode: mode });
      setSessionPermissionMode(activeSessionId, mode);
      updateSessionInList(activeSessionId, { permissionMode: mode as any });
      // Notify backend to sync REPL providers
      try {
        const ws = await ensureConnection();
        ws.send(JSON.stringify({ type: 'permission_mode_change', mode }));
      } catch { /* WS may not be connected yet — session update is sufficient */ }
    } catch (err) {
      console.error('Failed to update permission mode:', err);
    }
  };

  const confirmTrustMode = async () => {
    setShowTrustWarning(false);
    await applyPermissionMode('trust');
  };

  const permLabels: Record<string, { label: string; icon: JSX.Element; color: string }> = {
    read_only: { label: 'Read Only', icon: <Lock className="w-3.5 h-3.5" />, color: 'text-hub-tertiary' },
    ask: { label: 'Ask', icon: <Shield className="w-3.5 h-3.5" />, color: 'text-hub-warning' },
    smart: { label: 'Smart', icon: <Sparkles className="w-3.5 h-3.5" />, color: 'text-hub-accent' },
    trust: { label: 'Trust', icon: <Zap className="w-3.5 h-3.5" />, color: 'text-hub-success' },
  };

  const currentPerm = permLabels[permissionMode] ?? permLabels.ask;
  const hasRunningAgent = activeSessionId ? isSessionStreaming(activeSessionId) : false;
  const { width: panelWidth, onMouseDown: onPanelResize } = useResizablePanel({
    defaultWidth: 288, minWidth: 220, maxWidth: 500, side: 'right',
  });

  // Message action callbacks
  const handleCopyMessage = useCallback(async (msg: Message) => {
    const text = safeContent(msg.content);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      addToast('Copied', 'success');
    } catch {
      addToast('Failed to copy', 'error');
    }
  }, [addToast]);

  const handleQuoteMessage = useCallback((msg: Message) => {
    const text = safeContent(msg.content);
    if (!text) return;
    const agentName = msg.agentId ? agentMap.get(msg.agentId)?.displayName : 'Agent';
    const quote = `> ${agentName}: ${text.slice(0, 200).replace(/\n/g, '\n> ')}\n\n`;
    window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', { detail: { prompt: quote } }));
    addToast('Quoted', 'info');
  }, [agentMap, addToast]);

  const handleRegenerateMessage = useCallback((msg: Message) => {
    regenerate(msg.id);
  }, [regenerate]);

  const handleDeleteMessage = useCallback((msg: Message) => {
    deleteMessage(msg.id);
    addToast('Message deleted', 'info');
  }, [deleteMessage, addToast]);

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
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Session header with permission mode indicator */}
        <div className="px-4 py-2 border-b border-hub flex items-center gap-2 bg-hub-surface relative z-10">
          {/* Add/Remove agent buttons — only for group sessions */}
          {activeSession?.type === 'group' && (
            <>
              <button onClick={() => setShowAddAgents(true)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-hub-accent/30 text-hub-accent hover:bg-hub-accent/10 transition shrink-0"
                title="Add agent to group"
              >
                <Plus className="w-3 h-3" /> Add
              </button>
              <button onClick={() => setShowRemoveAgents(true)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-hub-danger/30 text-hub-danger hover:bg-hub-danger/10 transition shrink-0"
                title="Remove agent from group"
              >
                <Minus className="w-3 h-3" /> Rmv
              </button>
            </>
          )}

          {/* Session title */}
          <span className="text-xs text-hub-secondary font-medium truncate flex-1 min-w-0">
            {activeSession?.title ?? 'Session'}
          </span>

          {/* Session participants */}
          {sessionAgents.length > 0 && (
            <>
              <span className="text-[11px] text-hub-tertiary font-medium">Participants</span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-hub-accent/10 border border-hub-accent/30 text-hub-accent font-medium">You</span>
              {sessionAgents.map((a) => (
                <span key={a.id}
                  className="text-xs px-2 py-0.5 rounded-full border text-hub-secondary"
                  style={{ borderColor: agentColor(a.name), backgroundColor: agentColor(a.name) + '20' }}
                >
                  {a.displayName}
                </span>
              ))}
            </>
          )}

          {/* Permission mode dropdown */}
          <div className="relative shrink-0">
            <button
              onClick={() => setShowPermDropdown(!showPermDropdown)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition hover:bg-hub-hover ${currentPerm.color}`}
              title="Permission mode"
            >
              {currentPerm.icon}
              <span>{currentPerm.label}</span>
              <ChevronDown className="w-3 h-3" />
            </button>
            {showPermDropdown && (
              <div className="absolute top-full right-0 mt-1 bg-hub-raised border border-hub rounded-hub-lg shadow-xl z-50 w-36 overflow-hidden">
                {Object.entries(permLabels).map(([key, { label, icon, color }]) => (
                  <button
                    key={key}
                    onClick={() => handleChangePermissionMode(key)}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition ${
                      permissionMode === key ? 'bg-hub-active font-semibold' : 'hover:bg-hub-hover'
                    } ${color}`}
                  >
                    {icon} {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Settings button */}
          <button onClick={() => setSettingsOpen(true)} className="p-1.5 rounded hover:bg-hub-hover text-hub-tertiary transition shrink-0" title="Settings">
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto chat-scroll">
          {messages.map((msg: any) => (
            <React.Fragment key={msg.id}>
              <div className={`flex ${msg.senderType === 'human' ? 'flex-row-reverse' : ''} relative group`}>
                <div className="flex-1 min-w-0">
                  <MessageBubble
                    message={msg}
                    isStreaming={msg.status === 'streaming'}
                    agentDisplayName={msg.agentId ? agentMap.get(msg.agentId)?.displayName : undefined}
                    agentName={msg.agentId ? agentMap.get(msg.agentId)?.name : undefined}
                  />
                </div>
                {/* Message actions dropdown — show on hover for done/error messages */}
                {msg.status !== 'streaming' && msg.status !== 'sending' && (
                  <div className={`flex-shrink-0 flex items-start pt-2.5 ${msg.senderType === 'human' ? 'mr-3 order-first' : 'ml-1'}`}>
                    <MessageActions
                      message={msg}
                      agentDisplayName={msg.agentId ? agentMap.get(msg.agentId)?.displayName : undefined}
                      onCopy={() => handleCopyMessage(msg)}
                      onQuote={() => handleQuoteMessage(msg)}
                      onRegenerate={() => handleRegenerateMessage(msg)}
                      onDelete={() => handleDeleteMessage(msg)}
                    />
                  </div>
                )}
              </div>
              {msg.senderType === 'agent' && renderAgentInfo(msg.id, msg.status === 'streaming')}
              {diffCards.filter((card) => card.agentMessageId === msg.id).map((card) => (
                <DiffCard key={card.id} sessionId={activeSessionId} title={card.title} files={card.files} />
              ))}
              {/* Planner task plan: render after the Planner agent's message. Use ref to avoid duplicate panels when multiple planner messages exist. */}
              {msg.senderType === 'agent' && msg.agentId && (agentMap.get(msg.agentId)?.name === 'planner' || agentMap.get(msg.agentId)?.name?.startsWith('planner-')) && msg.status === 'done' && (
                <PlanRenderer planFromMessage={msg} taskPlans={taskPlans} confirmedPlans={confirmedPlans}
                  setConfirmedPlans={setConfirmedPlans} setTaskPlan={setTaskPlan} confirmPlan={confirmPlan}
                  renderedPlanIds={renderedPlanIds} />
              )}
            </React.Fragment>
          ))}
          {deploymentCards.map((card) => (
            <DeployCard key={card.deploymentId} sessionId={activeSessionId} deployment={card} />
          ))}
          {testReports.map((item) => <TestReportCard key={item.id} report={item.report} />)}
          {reviewReports.map((item) => <ReviewCard key={item.id} report={item.report} />)}
          <div ref={bottomRef} />
        </div>
        <MessageInput onSend={send} disabled={hasRunningAgent} mentionableAgents={mentionableAgents} />
        <QuoteToolbar selection={previewSelection} onDismiss={() => setPreviewSelection(null)} />
      </div>

      {/* Agent status panel — resizable right sidebar */}
      {sessionAgents.length > 0 && (
        <div className="hidden lg:flex flex-shrink-0" style={{ width: panelWidth }}>
          <div
            onMouseDown={onPanelResize}
            className="w-1 cursor-col-resize hover:bg-hub-accent/60 active:bg-hub-accent transition-colors flex-shrink-0"
            title="拖拽调整宽度"
          >
            <div className="w-4 h-full -ml-1.5" />
          </div>
          <div className="flex-1 min-w-0">
            <AgentStatusPanel sessionAgents={sessionAgents} onStopAgent={stopAgent} onReplanTask={sendReplan} onPreviewSelection={setPreviewSelection} />
          </div>
        </div>
      )}

      {/* Trust mode risk warning dialog */}
      {showTrustWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowTrustWarning(false)}>
          <div
            className="bg-hub-raised border border-hub rounded-hub-xl shadow-2xl w-96 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-hub-danger shrink-0" />
              <h3 className="text-sm font-semibold text-hub-primary">Enable Trust Mode?</h3>
            </div>
            <div className="text-xs text-hub-tertiary mb-1 space-y-1.5">
              <p>Trust mode grants the agent full autonomy:</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>Auto-approves all file writes, edits, and deletions</li>
                <li>Auto-approves all bash command execution</li>
                <li>Skips permission confirmation prompts</li>
              </ul>
              <p className="text-hub-warning font-medium mt-2">
                Only use this in Docker-sandboxed sessions or when you fully trust the agent's output.
              </p>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowTrustWarning(false)}
                className="px-4 py-1.5 text-xs font-medium text-hub-secondary hover:bg-hub-hover rounded-md transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmTrustMode}
                className="px-4 py-1.5 text-xs font-medium bg-hub-danger text-white rounded-md hover:bg-hub-danger/80 transition"
              >
                Enable Trust
              </button>
            </div>
          </div>
        </div>
      )}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {activeSession?.type === 'group' && (
        <>
          <AddAgentModal sessionId={activeSessionId} open={showAddAgents} onClose={() => setShowAddAgents(false)} />
          <RemoveAgentModal sessionId={activeSessionId} open={showRemoveAgents} onClose={() => setShowRemoveAgents(false)} />
        </>
      )}
    </div>
  );
}
