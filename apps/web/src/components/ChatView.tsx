import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../lib/api';
import { useChat } from '../hooks/useChat';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { MessageActions } from './MessageActions';
import { AgentStatusPanel } from './AgentStatusPanel';
import { QuoteToolbar } from './QuoteToolbar';
import { agentColor } from './AgentMentionPopup';
import { Shield, AlertTriangle, ChevronDown, Lock, Sparkles, Zap, Settings, Plus, Minus, FolderOpen } from 'lucide-react';
import { ConfirmationPanel } from './ConfirmationPanel';
import { SettingsPanel } from './SettingsPanel';
import { AddAgentModal } from './AddAgentModal';
import { RemoveAgentModal } from './RemoveAgentModal';
import { AgentConfigEditor } from './AgentConfigEditor';
import { DiffCard } from './DiffCard';
import { DeployCard } from './DeployCard';
import { TestReportCard } from './TestReportCard';
import { ReviewCard } from './ReviewCard';
import { WorkspaceSelector } from './WorkspaceSelector';
import { PptxCard } from './PptxCard';
import { HtmlPreviewCard } from './HtmlPreviewCard';
import { SessionLogPanel } from './SessionLogPanel';
import { RecoveryBanner } from './RecoveryBanner';
import { PinnedPanel } from './PinnedPanel';
import { PinnedPinMenu } from './PinnedPinMenu';
import type { Message, AgentConfig } from '@agenthub/shared';
import { safeContent, formatTokens } from '../lib/text';

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PLANS: Record<string, any[]> = {};
const EMPTY_DIFF_CARDS: any[] = [];
const EMPTY_DEPLOYMENT_CARDS: any[] = [];
const EMPTY_TEST_REPORTS: any[] = [];
const EMPTY_STR_ARR: string[] = [];
const EMPTY_REVIEW_REPORTS: any[] = [];

/** Renders ConfirmationPanel below a Planner agent's message (DAG lives in sidebar Tasks tab) */
function PlanRenderer({
  planFromMessage, sessionId, taskPlans, confirmedPlans, setConfirmedPlans, setTaskPlan, confirmPlan, renderedPlanIds,
}: {
  planFromMessage: any;
  sessionId: string;
  taskPlans: Record<string, any[]>;
  confirmedPlans: Set<string>;
  setConfirmedPlans: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTaskPlan: (sessionId: string, planId: string, tasks: any[]) => void;
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
            setTaskPlan(sessionId, planId, tasks.map((t: any) =>
              t.taskId === taskId ? { ...t, description: newDescription } : t));
          }}
          onUpdateField={(taskId, field, value) => {
            const resolved = field === 'dependsOn' && typeof value === 'string'
              ? value.split(',').map((s: string) => s.trim()).filter(Boolean)
              : value;
            setTaskPlan(sessionId, planId, tasks.map((t: any) =>
              t.taskId === taskId ? { ...t, [field]: resolved } : t));
          }}
          onCancel={() => {
            useAppStore.getState().removeTaskPlan(sessionId, planId);
          }}
        />
      ))}
    </>
  );
}

// --- Extracted sub-components for render isolation ---

/** Session header: permission mode, participants, settings. Only re-renders on session metadata changes. */
const SessionHeader = React.memo(function SessionHeader({
  activeSessionId, activeSession, sessionAgents, permissionMode, onPermissionChange, onSettingsOpen,
  onAddAgents, onRemoveAgents, onWorkspaceOpen, hasMessages,
}: {
  activeSessionId: string; activeSession: any; sessionAgents: AgentConfig[];
  permissionMode: string; onPermissionChange: (mode: string) => void;
  onSettingsOpen: () => void; onAddAgents: () => void; onRemoveAgents: () => void;
  onWorkspaceOpen: () => void; hasMessages: boolean;
}) {
  const [showPermDropdown, setShowPermDropdown] = useState(false);
  const permLabels: Record<string, { label: string; icon: JSX.Element; color: string }> = {
    read_only: { label: 'Read Only', icon: <Lock className="w-3.5 h-3.5" />, color: 'text-hub-tertiary' },
    ask: { label: 'Ask', icon: <Shield className="w-3.5 h-3.5" />, color: 'text-hub-warning' },
    smart: { label: 'Smart', icon: <Sparkles className="w-3.5 h-3.5" />, color: 'text-hub-accent' },
    trust: { label: 'Trust', icon: <Zap className="w-3.5 h-3.5" />, color: 'text-hub-success' },
  };
  const currentPerm = permLabels[permissionMode] ?? permLabels.ask;

  return (
    <div className="mx-2 mt-3 mb-4 px-4 py-2.5 flex items-center gap-2 flex-wrap min-h-[44px] bg-[oklch(0.88_0.003_95)] rounded-xl border border-hub shadow-sm relative z-10">
      {activeSession?.type === 'group' && (
        <>
          <button onClick={onAddAgents}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-hub-accent/30 text-hub-accent hover:bg-hub-accent/10 transition shrink-0"
            title="Add agent to group"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
          <button onClick={onRemoveAgents}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-hub-danger/30 text-hub-danger hover:bg-hub-danger/10 transition shrink-0"
            title="Remove agent from group"
          >
            <Minus className="w-3 h-3" /> Rmv
          </button>
        </>
      )}
      <span className="text-xs text-hub-secondary font-medium truncate flex-1 min-w-0">
        {activeSession?.title ?? 'Session'}
      </span>
      {sessionAgents.length > 0 && (
        <>
          <span className="text-[11px] text-hub-tertiary font-medium">Participants</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-hub-accent/10 border border-hub-accent/30 text-hub-accent font-medium">You</span>
          {sessionAgents.map((a) => (
            <span key={a.id}
              className="text-[11px] px-2 py-0.5 rounded-full border text-hub-secondary max-w-[120px] truncate shrink-0"
              style={{ borderColor: agentColor(a.name), backgroundColor: agentColor(a.name) + '20' }}
            >
              {a.displayName}
            </span>
          ))}
        </>
      )}
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
          <div className="absolute top-full right-0 mt-1 glass-surface-heavy border border-hub rounded-hub-lg shadow-xl z-50 w-36 overflow-hidden">
            {Object.entries(permLabels).map(([key, { label, icon, color }]) => (
              <button
                key={key}
                onClick={() => { setShowPermDropdown(false); onPermissionChange(key); }}
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
      <button onClick={onSettingsOpen} className="p-1.5 rounded hover:bg-hub-hover text-hub-tertiary transition shrink-0" title="Settings">
        <Settings className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => !hasMessages && onWorkspaceOpen()}
        className={`p-1.5 rounded transition shrink-0 ${
          hasMessages ? 'text-hub-muted/30 cursor-not-allowed' : 'hover:bg-hub-hover text-hub-tertiary'
        }`}
        title={hasMessages ? 'Workspace locked — session already started' : 'Set Workspace Directory'}
        disabled={hasMessages}
      >
        <FolderOpen className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});

/** Inline conflict retry button shown below conflict_unresolved messages. */
function ConflictRetryCard({ planId, taskIds, onRetry }: { planId: string; taskIds: string[]; onRetry: (planId: string, taskIds: string[]) => void }) {
  const [clicked, setClicked] = useState(false);
  return (
    <div className="mx-4 my-1 bg-hub-danger/10 border border-hub-danger/30 rounded-hub-lg px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-hub-secondary">Conflict tasks need retry</span>
        <button
          onClick={() => { setClicked(true); onRetry(planId, taskIds); }}
          disabled={clicked}
          className="ml-auto px-3 py-1 bg-hub-primary hover:bg-hub-primary/80 disabled:opacity-50 text-white text-xs rounded-md font-medium transition"
        >{clicked ? 'Retrying...' : `Retry ${taskIds.length} Task(s) Sequentially`}</button>
      </div>
    </div>
  );
}

/** Single message row with bubble, actions, agent info, and inline diff cards. Subscribes only to its own agentEvents. */
const MessageItem = React.memo(function MessageItem({
  msg, agentDisplayName, agentName, onCopy, onQuote, onPin, onRegenerate, onDelete, respondToPermission,
}: {
  msg: Message; agentDisplayName?: string; agentName?: string;
  onCopy: () => void; onQuote: () => void; onPin: () => void; onRegenerate: () => void; onDelete: () => void;
  respondToPermission: (id: string, allowed: boolean) => void;
}) {
  // Subscribe only to this message's agent events — no global store pollution
  const events = useAppStore((s) => s.agentEvents[msg.id]);
  const allDiffCards = useAppStore((s) => s.diffCards[msg.sessionId]);
  const diffCards = useMemo(() => allDiffCards?.filter((c) => c.agentMessageId === msg.id) ?? EMPTY_DIFF_CARDS, [allDiffCards, msg.id]);
  const storeResolvedIds = useAppStore((s) => s.resolvedPermissionIds);
  const [resolvedPermissions, setResolvedPermissions] = useState<Set<string>>(() => new Set());

  // Extract token usage
  const tokenUpdates = events?.filter((ev) => ev.type === 'token_update') ?? [];
  const lastToken = tokenUpdates[tokenUpdates.length - 1]?.details?.tokenUsage;
  const inputTokens = lastToken?.input ?? 0;
  const outputTokens = lastToken?.output ?? 0;
  const permissionReqs = events?.filter((ev) => ev.type === 'permission_request') ?? [];

  return (
    <>
      <div className={`flex ${msg.senderType === 'human' ? 'flex-row-reverse' : ''} relative group`}>
        <div className="flex-1 min-w-0">
          <MessageBubble message={msg} isStreaming={msg.status === 'streaming'}
            agentDisplayName={agentDisplayName} agentName={agentName} />
        </div>
        {msg.status !== 'streaming' && msg.status !== 'sending' && (
          <div className={`flex-shrink-0 flex items-start pt-2.5 ${msg.senderType === 'human' ? 'mr-3 order-first' : 'ml-1'}`}>
            <MessageActions message={msg} agentDisplayName={agentDisplayName}
              onCopy={onCopy} onQuote={onQuote} onPin={onPin} onRegenerate={onRegenerate} onDelete={onDelete} />
          </div>
        )}
      </div>
      {/* Agent info: token bar + permission requests */}
      {msg.senderType === 'agent' && (inputTokens > 0 || outputTokens > 0 || permissionReqs.length > 0) && (
        <div className="mx-4 my-1 space-y-1">
          {(inputTokens > 0 || outputTokens > 0) && (
            <div className="flex items-center gap-3 text-[11px] text-hub-tertiary px-1">
              <span title="Input tokens">↑ {formatTokens(inputTokens)}</span>
              <span title="Output tokens">↓ {formatTokens(outputTokens)}</span>
              <span title="Total tokens">Σ {formatTokens(inputTokens + outputTokens)}</span>
            </div>
          )}
          {permissionReqs.map((ev) => {
            const pid = ev.details.permissionId ?? ev.id;
            const resolved = resolvedPermissions.has(pid) || storeResolvedIds.has(pid);
            // Hide the card entirely once resolved
            if (resolved) return null;
            const toolInput = (ev.details as any).toolInput as Record<string, unknown> | undefined;
            const isWrite = ev.details.tool === 'Write' || ev.details.tool === 'Edit' || ev.details.tool === 'MultiEdit';
            const filePath: string | undefined = ev.details.path || (typeof toolInput?.file_path === 'string' ? toolInput.file_path : undefined);
            const newContent: string | undefined = typeof toolInput?.content === 'string' ? toolInput.content : undefined;
            const oldContent: string | undefined = typeof toolInput?.oldContent === 'string' ? toolInput.oldContent : undefined;
            return (
              <div key={ev.id} className="bg-hub-warning/10 border border-hub-warning/30 rounded-hub-lg px-4 py-3 my-2 animate-pulse">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-4 h-4 text-hub-warning" />
                  <span className="text-sm font-medium text-hub-warning">Permission Request</span>
                  <span className="text-[10px] text-hub-muted ml-auto">{ev.details.tool}</span>
                </div>
                {filePath && <div className="text-xs text-hub-tertiary mb-2">Path: <span className="text-hub-secondary font-mono">{filePath}</span></div>}
                {isWrite && (oldContent !== undefined || !!newContent) ? (
                  <div className="mb-3 space-y-1">
                    {oldContent !== undefined && (
                      <details className="text-xs">
                        <summary className="text-hub-tertiary cursor-pointer hover:text-hub-secondary">View diff (before → after)</summary>
                        <div className="grid grid-cols-2 gap-1 mt-1 max-h-48 overflow-auto">
                          <pre className="bg-hub-danger/10 text-hub-danger text-[10px] p-2 rounded whitespace-pre-wrap font-mono">{String(oldContent || '').slice(0, 3000) || '(new file)'}</pre>
                          <pre className="bg-hub-success/10 text-hub-success text-[10px] p-2 rounded whitespace-pre-wrap font-mono">{String(newContent || '').slice(0, 3000) || '(no content)'}</pre>
                        </div>
                      </details>
                    )}
                    {oldContent === undefined && newContent && (
                      <div className="text-xs text-hub-tertiary">
                        New file <span className="font-mono text-hub-secondary">{filePath}</span> ({newContent.length} chars)
                      </div>
                    )}
                  </div>
                ) : (
                  ev.details.tool === 'Bash' && typeof toolInput?.command === 'string' && (
                    <div className="mb-3">
                      <pre className="bg-hub-raised text-hub-secondary text-[10px] p-2 rounded whitespace-pre-wrap font-mono max-h-32 overflow-auto">{String(toolInput.command).slice(0, 2000)}</pre>
                    </div>
                  )
                )}
                {msg.status === 'streaming' ? (
                  <div className="flex gap-2">
                    <button onClick={() => { setResolvedPermissions(prev => new Set(prev).add(pid)); respondToPermission(pid, true); }}
                      className="px-4 py-1.5 bg-hub-success hover:bg-hub-success/80 text-white text-xs rounded-md font-medium transition">Allow</button>
                    <button onClick={() => { setResolvedPermissions(prev => new Set(prev).add(pid)); respondToPermission(pid, false); }}
                      className="px-4 py-1.5 bg-hub-danger hover:bg-hub-danger/80 text-white text-xs rounded-md font-medium transition">Deny</button>
                  </div>
                ) : (
                  <span className="text-xs text-hub-muted italic">Agent terminated — request expired</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* Inline diff cards for this message */}
      {diffCards.map((card) => (
        <DiffCard key={card.id} sessionId={msg.sessionId} title={card.title} files={card.files} />
      ))}
    </>
  );
}, (prev, next) => {
  // Custom comparator: only re-render if message content, status, or agent info changed
  return prev.msg === next.msg
    && prev.msg.status === next.msg.status
    && prev.msg.content === next.msg.content
    && prev.agentDisplayName === next.agentDisplayName
    && prev.agentName === next.agentName;
});

/** Bottom artifact feed: deployment cards, test reports, review reports. Only re-renders on artifact changes. */
const ArtifactFeed = React.memo(function ArtifactFeed({ sessionId }: { sessionId: string }) {
  const deploymentCards = useAppStore((s) => s.deploymentCards[sessionId] ?? EMPTY_DEPLOYMENT_CARDS);
  const testReports = useAppStore((s) => s.testReports[sessionId] ?? EMPTY_TEST_REPORTS);
  const reviewReports = useAppStore((s) => s.reviewReports[sessionId] ?? EMPTY_REVIEW_REPORTS);

  return (
    <>
      {deploymentCards.map((card) => (
        <DeployCard key={card.deploymentId} sessionId={sessionId} deployment={card} />
      ))}
      {testReports.map((item) => <TestReportCard key={item.id} report={item.report} />)}
      {reviewReports.map((item) => <ReviewCard key={item.id} report={item.report} />)}
    </>
  );
});

export function ChatView() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);

  // Ensure agents are loaded when entering a session (handles race with loadSessions)
  useEffect(() => {
    if (agents.length === 0 && activeSessionId) {
      api.getAgents().then(setAgents).catch(() => {});
    }
  }, [activeSessionId, agents.length, setAgents]);

  // useShallow: batch selectors to avoid re-render on reference change when content is same
  const [messages, taskPlans] = useAppStore(useShallow((s) => [
    activeSessionId ? (s.messages[activeSessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
    activeSessionId ? (s.taskPlans[activeSessionId] ?? EMPTY_PLANS) : EMPTY_PLANS,
  ]));

  const isSessionStreaming = useAppStore((s) => s.isSessionStreaming);
  const streamingMessageIds = useAppStore((s) => s.streamingMessages[activeSessionId ?? ''] ?? EMPTY_STR_ARR);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const prevMessageLenRef = useRef(messages.length);
  const setTaskPlan = useAppStore((s) => s.setTaskPlan);
  const { send, ensureConnection, stopAgent, respondToPermission, confirmPlan, deleteMessage, regenerate, sendReplan, forceCompleteTask, forceFailTask } = useChat(activeSessionId ?? '');
  const addToast = useAppStore((s) => s.addToast);
  const [confirmedPlans, setConfirmedPlans] = useState<Set<string>>(() => new Set());
  const renderedPlanIds = useRef(new Set<string>());

  // Session Log tab state
  const [activeTab, setActiveTab] = useState<'chat' | 'pinned' | 'log'>('chat');
  const [commLogEntries, setCommLogEntries] = useState<any[]>([]);

  // Pinned tab state
  const [pinnedEvents, setPinnedEvents] = useState<Array<{ type: string; pinned?: any; pinnedId?: string }>>([]);
  const [pinnedCount, setPinnedCount] = useState(0);

  // Listen for real-time comm_log events from WebSocket
  useEffect(() => {
    const handler = (e: Event) => {
      const entry = (e as CustomEvent).detail;
      if (entry) setCommLogEntries(prev => [...prev, entry]);
    };
    window.addEventListener('comm_log', handler);
    return () => window.removeEventListener('comm_log', handler);
  }, []);

  // Listen for real-time pinned events from WebSocket
  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (!data || (data.sessionId && data.sessionId !== activeSessionId)) return;
      setPinnedEvents(prev => [...prev, data]);
      if (data.type === 'pinned_added') setPinnedCount(c => c + 1);
      if (data.type === 'pinned_removed') setPinnedCount(c => Math.max(0, c - 1));
    };
    window.addEventListener('pinned_event', handler);
    return () => window.removeEventListener('pinned_event', handler);
  }, [activeSessionId]);

  // Clear comm log and pinned entries when session changes
  useEffect(() => {
    setCommLogEntries([]);
    setPinnedEvents([]);
    setPinnedCount(0);
    setActiveTab('chat');
    // Fetch initial pinned count
    if (activeSessionId) {
      api.getPinned(activeSessionId).then(items => setPinnedCount(items.length)).catch(() => {});
    }
  }, [activeSessionId]);

  // New artifact detection — snapshot-based: only show files created AFTER session starts
  const initialFilesRef = useRef<Set<string>>(new Set());
  const snapshotReadyRef = useRef(false);
  const [latestArtifact, setLatestArtifact] = useState<{ path: string; name: string; type: 'pptx' | 'html' } | null>(null);
  const [dismissedPaths, setDismissedPaths] = useState<Set<string>>(new Set());

  // Reset snapshot when session changes
  useEffect(() => {
    initialFilesRef.current = new Set();
    snapshotReadyRef.current = false;
    setLatestArtifact(null);
    setDismissedPaths(new Set());
  }, [activeSessionId]);

  const scanNewArtifacts = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      const result = await api.getWorkspaceTree(activeSessionId);
      const roots: any[] = [...(result?.tree ?? []), ...(result?.workspaceTree ?? [])];

      // Collect all file paths
      const allFiles: { path: string; name: string; modifiedAt: number }[] = [];
      const collect = (nodes: any[]) => {
        for (const node of nodes) {
          if (node.type === 'file') allFiles.push({ path: node.path, name: node.name, modifiedAt: node.modifiedAt ?? 0 });
          if (node.type === 'directory' && node.children?.length) collect(node.children);
        }
      };
      collect(roots);

      // First call: take snapshot, don't show any cards
      if (!snapshotReadyRef.current) {
        initialFilesRef.current = new Set(allFiles.map(f => f.path));
        snapshotReadyRef.current = true;
        return;
      }

      // Subsequent calls: find new files not in snapshot and not dismissed
      const newFiles = allFiles.filter(f => !initialFilesRef.current.has(f.path) && !dismissedPaths.has(f.path));
      const previewable = newFiles.filter(f => /\.pptx$/i.test(f.name) || /\.html?$/i.test(f.name));
      previewable.sort((a, b) => b.modifiedAt - a.modifiedAt);
      const newest = previewable[0] ?? null;

      if (newest) {
        const type = /\.pptx$/i.test(newest.name) ? 'pptx' as const : 'html' as const;
        setLatestArtifact({ path: newest.path, name: newest.name, type });
      } else {
        setLatestArtifact(null);
      }
    } catch { /* sandbox not ready */ }
  }, [activeSessionId, dismissedPaths]);

  const dismissArtifact = useCallback(() => {
    if (latestArtifact) {
      setDismissedPaths(prev => new Set(prev).add(latestArtifact.path));
      setLatestArtifact(null);
    }
  }, [latestArtifact]);

  // Poll workspace tree every 3s for new artifacts
  useEffect(() => {
    scanNewArtifacts();
    const interval = setInterval(scanNewArtifacts, 3000);
    return () => clearInterval(interval);
  }, [scanNewArtifacts]);

  // Memoize agentMap — only rebuild when agents array changes
  const agentMap = useMemo(() => {
    const map = new Map<string, AgentConfig>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  // Determine session type and participants — memoized
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionAgents = useMemo((): AgentConfig[] => {
    return (activeSession as any)?.agents
      ?.map((sa: any) => agentMap.get(sa.agentId) ?? {
        id: sa.agentId, name: sa.name, displayName: sa.displayName,
        description: '', systemPrompt: '',
      } as AgentConfig) ?? [];
  }, [activeSession, agentMap]);

  // @mention agents: in group mode, restrict to session members; in solo, show all
  const mentionableAgents = useMemo(() => {
    if (!activeSession || activeSession.type !== 'group') return agents;
    const sessionAgentIds = new Set(((activeSession as any)?.agents || []).map((sa: any) => sa.agentId));
    return agents.filter((a) => sessionAgentIds.has(a.id));
  }, [activeSession, agents]);

  // Scroll behavior: auto-scroll only when user is already near bottom.
  // When scrolled up and new messages arrive, show a "jump to bottom" button instead.
  const handleChatScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = dist < 120;
    setIsNearBottom(near);
    setShowScrollButton(!near);
  }, []);

  // New messages arrived
  useEffect(() => {
    if (isNearBottom) {
      const prevLen = prevMessageLenRef.current;
      // Instant scroll on initial load (many messages at once), smooth for new messages
      const behavior: ScrollBehavior = prevLen === 0 ? 'instant' : 'smooth';
      bottomRef.current?.scrollIntoView({ behavior });
    } else if (messages.length > prevMessageLenRef.current) {
      setShowScrollButton(true);
    }
    prevMessageLenRef.current = messages.length;
  }, [messages, isNearBottom]);

  // Streaming content — only follow if user is near bottom
  const messagesLength = messages.length;
  useEffect(() => {
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messagesLength, isNearBottom]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollButton(false);
  }, []);

  const sessionPermissionModes = useAppStore((s) => s.sessionPermissionModes);
  const setSessionPermissionMode = useAppStore((s) => s.setSessionPermissionMode);
  const updateSessionInList = useAppStore((s) => s.updateSessionInList);
  const [showTrustWarning, setShowTrustWarning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showAddAgents, setShowAddAgents] = useState(false);
  const [showRemoveAgents, setShowRemoveAgents] = useState(false);
  const configAgentId = useAppStore((s) => s.configAgentId);
  const setConfigAgentId = useAppStore((s) => s.setConfigAgentId);
  const [showWorkspaceSelector, setShowWorkspaceSelector] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<{
    text: string;
    rect: { top: number; left: number; width: number; height: number };
    url: string;
  } | null>(null);

  const permissionMode = !activeSessionId ? 'ask'
    : sessionPermissionModes[activeSessionId] ?? (activeSession as any)?.permissionMode ?? 'ask';

  const handleChangePermissionMode = async (mode: string) => {
    if (!activeSessionId) return;
    if (mode === 'trust') { setShowTrustWarning(true); return; }
    await applyPermissionMode(mode);
  };

  const applyPermissionMode = async (mode: string) => {
    if (!activeSessionId) return;
    try {
      await api.updateSession(activeSessionId, { permissionMode: mode });
      setSessionPermissionMode(activeSessionId, mode);
      updateSessionInList(activeSessionId, { permissionMode: mode as any });
      try {
        const ws = await ensureConnection();
        ws.send(JSON.stringify({ type: 'permission_mode_change', mode }));
      } catch { /* WS may not be connected yet */ }
    } catch (err) {
      console.error('Failed to update permission mode:', err);
    }
  };

  const confirmTrustMode = async () => {
    setShowTrustWarning(false);
    await applyPermissionMode('trust');
  };

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
      // Fallback for HTTP (navigator.clipboard requires HTTPS)
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        addToast('Copied', 'success');
      } catch {
        addToast('Failed to copy', 'error');
      }
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

  const handlePinMessage = useCallback((msg: Message) => {
    api.createPinned(activeSessionId!, {
      sourceType: 'message',
      content: msg.content,
      sourceMessageId: msg.id,
      title: msg.content.slice(0, 80).split('\n')[0],
    }).then(() => {
      addToast('Message pinned', 'success');
    }).catch(() => {
      addToast('Failed to pin message', 'error');
    });
  }, [activeSessionId, addToast]);

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
        <SessionHeader
          activeSessionId={activeSessionId!}
          activeSession={activeSession}
          sessionAgents={sessionAgents}
          permissionMode={permissionMode}
          onPermissionChange={handleChangePermissionMode}
          onSettingsOpen={() => setSettingsOpen(true)}
          onAddAgents={() => setShowAddAgents(true)}
          onRemoveAgents={() => setShowRemoveAgents(true)}
          onWorkspaceOpen={() => setShowWorkspaceSelector(true)}
          hasMessages={messages.length > 0}
        />
        {/* Tab bar */}
        <div className="flex border-b border-hub glass-surface-light text-xs">
          <button
            className={`px-4 py-1.5 font-medium transition-colors ${activeTab === 'chat' ? 'text-hub-accent border-b-2 border-hub-accent' : 'text-hub-muted hover:text-hub-secondary'}`}
            onClick={() => setActiveTab('chat')}
          >
            Chat
          </button>
          <button
            className={`px-4 py-1.5 font-medium transition-colors ${activeTab === 'pinned' ? 'text-hub-accent border-b-2 border-hub-accent' : 'text-hub-muted hover:text-hub-secondary'}`}
            onClick={() => setActiveTab('pinned')}
          >
            Pinned{pinnedCount > 0 ? ` (${pinnedCount})` : ''}
          </button>
          <button
            className={`px-4 py-1.5 font-medium transition-colors ${activeTab === 'log' ? 'text-hub-accent border-b-2 border-hub-accent' : 'text-hub-muted hover:text-hub-secondary'}`}
            onClick={() => setActiveTab('log')}
          >
            Session Log
          </button>
        </div>
        {activeTab === 'pinned' ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 glass-surface-light border-b border-hub">
              <span className="text-xs text-hub-secondary font-medium">Pinned Messages</span>
              <PinnedPinMenu
                sessionId={activeSessionId!}
                messages={messages}
                onPinned={() => {
                  api.getPinned(activeSessionId!).then(items => setPinnedCount(items.length));
                }}
                onError={(msg) => addToast(msg, 'error')}
              />
            </div>
            <PinnedPanel sessionId={activeSessionId!} wsPinnedEvents={pinnedEvents} />
          </div>
        ) : activeTab === 'log' ? (
          <SessionLogPanel sessionId={activeSessionId!} wsEntries={commLogEntries} />
        ) : (
        <div className="flex-1 overflow-y-auto chat-scroll" ref={scrollContainerRef} onScroll={handleChatScroll}>
          <RecoveryBanner sessionId={activeSessionId!} />
          {messages.map((msg: Message) => (
            <React.Fragment key={msg.id}>
              <MessageItem
                msg={msg}
                agentDisplayName={msg.agentId ? agentMap.get(msg.agentId)?.displayName : undefined}
                agentName={msg.agentId ? agentMap.get(msg.agentId)?.name : undefined}
                onCopy={() => handleCopyMessage(msg)}
                onQuote={() => handleQuoteMessage(msg)}
                onPin={() => handlePinMessage(msg)}
                onRegenerate={() => handleRegenerateMessage(msg)}
                onDelete={() => handleDeleteMessage(msg)}
                respondToPermission={respondToPermission}
              />
              {/* Conflict retry button */}
              {msg.senderType === 'agent' && (msg as any).metadata?.conflictActions && msg.status === 'done' && (
                <ConflictRetryCard
                  planId={(msg as any).metadata.conflictActions.planId}
                  taskIds={(msg as any).metadata.conflictActions.taskIds}
                  onRetry={async (planId, taskIds) => {
                    const ws = await ensureConnection();
                    ws.send(JSON.stringify({ type: 'conflict_retry', planId, taskIds }));
                  }}
                />
              )}
              {msg.senderType === 'agent' && msg.agentId
                && (agentMap.get(msg.agentId)?.name === 'planner' || agentMap.get(msg.agentId)?.name?.startsWith('planner-'))
                && msg.status === 'done' && (
                <PlanRenderer planFromMessage={msg} sessionId={activeSessionId!} taskPlans={taskPlans} confirmedPlans={confirmedPlans}
                  setConfirmedPlans={setConfirmedPlans} setTaskPlan={setTaskPlan} confirmPlan={confirmPlan}
                  renderedPlanIds={renderedPlanIds} />
              )}
            </React.Fragment>
          ))}
          <ArtifactFeed sessionId={activeSessionId!} />
          {/* Inline artifact preview — only newly created PPTX/HTML files */}
          {latestArtifact?.type === 'pptx' && (
            <PptxCard
              key={latestArtifact.path}
              sessionId={activeSessionId}
              filePath={latestArtifact.path}
              fileName={latestArtifact.name}
              onDismiss={dismissArtifact}
            />
          )}
          {latestArtifact?.type === 'html' && (
            <HtmlPreviewCard
              key={latestArtifact.path}
              sessionId={activeSessionId}
              filePath={latestArtifact.path}
              fileName={latestArtifact.name}
              onDismiss={dismissArtifact}
            />
          )}
          <div ref={bottomRef} />
        </div>
        )}
        {activeTab === 'chat' && (
          <>
            {showScrollButton && (
              <div className="flex justify-center -mb-1">
                <button onClick={scrollToBottom}
                  className="w-8 h-8 flex items-center justify-center bg-hub-surface border border-hub rounded-full shadow-md hover:bg-hub-hover transition-all"
                  title="回到最新消息"
                >
                  <ChevronDown className="w-5 h-5 text-hub-accent" />
                </button>
              </div>
            )}
            <MessageInput onSend={send} disabled={hasRunningAgent} mentionableAgents={mentionableAgents} streamingMessageIds={streamingMessageIds} onStopAgent={stopAgent} />
            <QuoteToolbar selection={previewSelection} onDismiss={() => setPreviewSelection(null)} />
          </>
        )}
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
            <AgentStatusPanel sessionAgents={sessionAgents} onStopAgent={stopAgent} onReplanTask={sendReplan} onPreviewSelection={setPreviewSelection} onForceComplete={forceCompleteTask} onForceFail={forceFailTask} onConfigureAgent={setConfigAgentId} />
          </div>
        </div>
      )}

      {/* Trust mode risk warning dialog */}
      {showTrustWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowTrustWarning(false)}>
          <div
            className="glass-surface-heavy border border-hub rounded-hub-xl shadow-2xl w-96 p-5"
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
      {configAgentId && (
        <AgentConfigEditor
          agentId={configAgentId}
          onClose={() => setConfigAgentId(null)}
          onSaved={() => setConfigAgentId(null)}
        />
      )}
      {activeSession?.type === 'group' && (
        <>
          <AddAgentModal sessionId={activeSessionId} open={showAddAgents} onClose={() => setShowAddAgents(false)} />
          <RemoveAgentModal sessionId={activeSessionId} open={showRemoveAgents} onClose={() => setShowRemoveAgents(false)} />
        </>
      )}
      {showWorkspaceSelector && activeSessionId && (
        <WorkspaceSelector
          sessionId={activeSessionId}
          onClose={() => setShowWorkspaceSelector(false)}
          onWorkspaceChanged={(path) => {
            console.log('Workspace changed to:', path);
          }}
        />
      )}
    </div>
  );
}
