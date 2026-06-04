import { create } from 'zustand';
import type { Session, Message, AgentConfig } from '@agenthub/shared';

export interface AgentEvent {
  id: string;
  type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start' | 'subagent_result' | 'permission_request' | 'token_update' | 'file_produced' | 'phase_complete' | 'skill_use';
  timestamp: number;
  agentId?: string;
  details: {
    toolName?: string;
    input?: Record<string, unknown>;
    inputPreview?: string;
    content?: string;
    resultPreview?: string;
    agentType?: string;
    description?: string;
    tool?: string;
    path?: string;
    permissionId?: string;
    toolInput?: Record<string, unknown>;
    oldContent?: string;
    tokenUsage?: { input: number; output: number; cacheRead?: number; cacheCreate?: number; contextPct?: number };
    skillName?: string;
    summary?: string;
    filePath?: string;
  };
}

export interface DiffCardState {
  id: string;
  sessionId: string;
  agentMessageId?: string;
  title: string;
  files: {
    path: string;
    diff: string;
    hunks: { id: string; header: string; lines: string[]; oldStart?: number; oldLines?: number; newStart?: number; newLines?: number }[];
    baseVersionId?: string;
    conflict?: { filePath: string; agents: string[]; ranges: { start: number; end: number }[] };
  }[];
  createdAt: number;
}

export interface DeploymentCardState {
  deploymentId: string;
  target: string;
  status: string;
  logs: string[];
  url?: string;
  imageSha?: string;
  buildTimeMs?: number;
  error?: string;
  updatedAt: number;
}

export interface TestReportState {
  id: string;
  report: any;
  exitCode: number;
  timestamp: number;
}

export interface ReviewReportState {
  id: string;
  report: any;
  timestamp: number;
}

export interface Toast {
  id: string;
  message: string;
  type: 'error' | 'info' | 'success';
}

interface AppState {
  token: string | null;
  user: { id: string; username: string; avatarUrl: string } | null;
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  agentEvents: Record<string, AgentEvent[]>;
  agents: AgentConfig[];
  configAgentId: string | null;
  setConfigAgentId: (id: string | null) => void;
  streamingMessages: Record<string, string[]>;
  trustMode: boolean;
  sessionPermissionModes: Record<string, string>;
  orchestrationMode: 'parallel' | 'sequential';
  setOrchestrationMode: (mode: 'parallel' | 'sequential') => void;
  taskPlans: Record<string, Record<string, TaskState[]>>;   // sessionId → planId → tasks
  planSummaries: Record<string, Record<string, { total: number; completed: number; failed: number; fileChanges: string[]; timestamp: number }>>; // sessionId → planId → summary
  diffCards: Record<string, DiffCardState[]>;
  deploymentCards: Record<string, DeploymentCardState[]>;
  testReports: Record<string, TestReportState[]>;
  reviewReports: Record<string, ReviewReportState[]>;
  setPlanSummary: (sessionId: string, planId: string, summary: { total: number; completed: number; failed: number; fileChanges: string[]; timestamp: number }) => void;
  planSessionMap: Record<string, string>; // planId → sessionId (reverse index for update methods)

  setToken: (token: string | null) => void;
  setUser: (user: any) => void;
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  setAgents: (agents: AgentConfig[]) => void;
  addMessage: (sessionId: string, msg: Message) => void;
  appendToMessage: (sessionId: string, msgId: string, chunk: string) => void;
  setMessageStatus: (sessionId: string, msgId: string, status: string) => void;
  replaceMessageContent: (sessionId: string, msgId: string, content: string) => void;
  updateMessageTokens: (sessionId: string, msgId: string, tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }) => void;
  addAgentEvent: (messageId: string, event: AgentEvent) => void;
  addStreamingMessage: (sessionId: string, msgId: string) => void;
  setTrustMode: (mode: boolean) => void;
  setSessionPermissionMode: (sessionId: string, mode: string) => void;
  updateSessionInList: (sessionId: string, updates: Partial<Session>) => void;
  addAgentToSession: (sessionId: string, agent: { id: string; name: string; displayName: string }) => void;
  removeAgentFromSession: (sessionId: string, agentId: string) => void;
  removeStreamingMessage: (sessionId: string, msgId: string) => void;
  isSessionStreaming: (sessionId: string) => boolean;
  setTaskPlan: (sessionId: string, planId: string, tasks: TaskState[]) => void;
  removeTaskPlan: (sessionId: string, planId: string) => void;
  updateTaskStatus: (planId: string, taskId: string, status: TaskState['status']) => void;
  updateTaskField: (planId: string, taskId: string, field: string, value: any) => void;
  addDiffCard: (sessionId: string, card: DiffCardState) => void;
  upsertDeploymentCard: (sessionId: string, card: Omit<DeploymentCardState, 'logs' | 'updatedAt'> & { log?: string; timestamp?: number }) => void;
  addTestReport: (sessionId: string, report: TestReportState) => void;
  addReviewReport: (sessionId: string, report: ReviewReportState) => void;
  setTaskAgent: (planId: string, taskId: string, agentId: string, agentName: string) => void;
  agentCurrentTask: Record<string, { planId: string; taskId: string; title: string } | null>;
  agentTaskCounts: Record<string, number>;
  unreadCounts: Record<string, number>;
  incrementUnread: (sessionId: string) => void;
  clearUnread: (sessionId: string) => void;
  clearSessionEvents: (sessionId: string) => void;
  inboxNotifications: Record<string, number>;
  addInboxNotification: (agentName: string) => void;
  clearInboxNotifications: (agentName: string) => void;
  toasts: Toast[];
  addToast: (message: string, type?: 'error' | 'info' | 'success') => void;
  deleteMessage: (sessionId: string, msgId: string) => void;
  removeToast: (id: string) => void;
  skillStats: Record<string, { skillName: string; count: number }[]>;
  planRecoveries: Record<string, { planId: string; planTitle: string; pendingCount: number; pendingTasks: { id: string; title: string; agentType: string }[] }[]>;
  setRecoveryPlans: (sessionId: string, plans: { planId: string; planTitle: string; pendingCount: number; pendingTasks: { id: string; title: string; agentType: string }[] }[]) => void;
  removeRecoveryPlan: (sessionId: string, planId: string) => void;
}

export interface TaskState {
  taskId: string;
  planId: string;
  title: string;
  agentType: string;
  status: 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'blocked';
  dependsOn: string[];
  progress?: { completed: number; total: number };
  assignedAgentId?: string;
  assignedAgentName?: string;
  expectedOutput?: string;
  priority?: string;
  description?: string;
}

export const useAppStore = create<AppState>((set, get) => ({
  token: localStorage.getItem('agenthub_token'),
  user: null,
  sessions: [],
  activeSessionId: null,
  messages: {},
  agentEvents: {},
  agents: [],
  configAgentId: null,
  streamingMessages: {},
  trustMode: true,
  sessionPermissionModes: {},
  orchestrationMode: 'parallel' as const,
  taskPlans: {},
  planSummaries: {},
  planSessionMap: {},
  diffCards: {},
  deploymentCards: {},
  testReports: {},
  reviewReports: {},
  agentCurrentTask: {},
  agentTaskCounts: {},
  unreadCounts: {},
  inboxNotifications: {},
  toasts: [],
  skillStats: {},
  planRecoveries: {},

  setToken: (token) => {
    if (token) localStorage.setItem('agenthub_token', token);
    else localStorage.removeItem('agenthub_token');
    set({ token });
  },

  setUser: (user) => set({ user }),

  setSessions: (sessions) => set({ sessions }),

  setActiveSession: (id) => {
    const prev = get().activeSessionId;
    if (prev && prev !== id) {
      // Keep events but trim to prevent memory bloat
      // Always preserve token_update events for dashboard display
      const prevMsgIds = new Set((get().messages[prev] ?? []).map(m => m.id));
      const filtered: Record<string, AgentEvent[]> = {};
      for (const [msgId, evts] of Object.entries(get().agentEvents)) {
        if (prevMsgIds.has(msgId)) {
          // Keep last 5 events + all token_update events
          const recent = evts.slice(-5);
          const tokenUpdates = evts.filter(e => e.type === 'token_update');
          const recentIds = new Set(recent.map(e => e.id));
          const extra = tokenUpdates.filter(e => !recentIds.has(e.id));
          filtered[msgId] = [...extra, ...recent];
        } else {
          filtered[msgId] = evts;
        }
      }
      set({ activeSessionId: id, agentEvents: filtered });
    } else {
      set({ activeSessionId: id });
    }
  },

  setAgents: (agents) => set({ agents }),
  setConfigAgentId: (configAgentId) => set({ configAgentId }),

  setTrustMode: (trustMode) => set({ trustMode }),
  setOrchestrationMode: (orchestrationMode) => set({ orchestrationMode }),

  setSessionPermissionMode: (sessionId, mode) =>
    set((state) => ({
      sessionPermissionModes: { ...state.sessionPermissionModes, [sessionId]: mode },
    })),

  updateSessionInList: (sessionId, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...updates } : s
      ),
    })),

  addAgentToSession: (sessionId: string, agent: { id: string; name: string; displayName: string }) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const agents = s.agents || [];
        if (agents.find((a) => a.agentId === agent.id)) return s;
        return { ...s, agents: [...agents, { agentId: agent.id, name: agent.name, displayName: agent.displayName }] };
      }),
    })),

  removeAgentFromSession: (sessionId: string, agentId: string) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const agents = (s.agents || []).filter((a) => a.agentId !== agentId);
        return { ...s, agents };
      }),
    })),

  addStreamingMessage: (sessionId, msgId) => set((state) => {
    const existing = state.streamingMessages[sessionId] ?? [];
    if (existing.includes(msgId)) return state;
    return { streamingMessages: { ...state.streamingMessages, [sessionId]: [...existing, msgId] } };
  }),

  removeStreamingMessage: (sessionId, msgId) => set((state) => {
    const existing = state.streamingMessages[sessionId] ?? [];
    return { streamingMessages: { ...state.streamingMessages, [sessionId]: existing.filter((id) => id !== msgId) } };
  }),

  isSessionStreaming: (sessionId) => {
    const s = get().streamingMessages[sessionId];
    return s ? s.length > 0 : false;
  },

  addMessage: (sessionId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] ?? []), msg],
      },
    })),

  replaceMessageContent: (sessionId, msgId, content) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId];
      if (!sessionMsgs) return state;
      const idx = sessionMsgs.findIndex((m) => m.id === msgId);
      if (idx < 0) return state;
      const next = sessionMsgs.slice();
      next[idx] = { ...sessionMsgs[idx], content };
      return { messages: { ...state.messages, [sessionId]: next } };
    }),

  appendToMessage: (sessionId, msgId, chunk) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId];
      if (!sessionMsgs) return state;
      const idx = sessionMsgs.findIndex((m) => m.id === msgId);
      if (idx < 0) return state;
      const updated = { ...sessionMsgs[idx], content: sessionMsgs[idx].content + chunk };
      const next = sessionMsgs.slice();
      next[idx] = updated;
      return { messages: { ...state.messages, [sessionId]: next } };
    }),

  setMessageStatus: (sessionId, msgId, status) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId];
      if (!sessionMsgs) return state;
      const idx = sessionMsgs.findIndex((m) => m.id === msgId);
      if (idx < 0) return state;
      const updated = { ...sessionMsgs[idx], status: status as Message['status'] };
      const next = sessionMsgs.slice();
      next[idx] = updated;
      return { messages: { ...state.messages, [sessionId]: next } };
    }),

  updateMessageTokens: (sessionId, msgId, tokens) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId];
      if (!sessionMsgs) return state;
      const idx = sessionMsgs.findIndex((m) => m.id === msgId);
      if (idx < 0) return state;
      const updated = {
        ...sessionMsgs[idx],
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheCreateTokens: tokens.cacheCreateTokens,
      };
      const next = sessionMsgs.slice();
      next[idx] = updated;
      return { messages: { ...state.messages, [sessionId]: next } };
    }),

  addAgentEvent: (messageId, event) =>
    set((state) => {
      const nextAgentEvents = {
        ...state.agentEvents,
        [messageId]: [...(state.agentEvents[messageId] ?? []), event],
      };

      if (event.type === 'skill_use') {
        const sn = event.details.skillName || 'unknown';
        const an = (event as any).agentName || 'unknown';
        const existing = state.skillStats[an] || [];
        const idx = existing.findIndex(s => s.skillName === sn);
        let nextStats: typeof state.skillStats;
        if (idx >= 0) {
          nextStats = {
            ...state.skillStats,
            [an]: existing.map((s, i) => i === idx ? { ...s, count: s.count + 1 } : s),
          };
        } else {
          nextStats = {
            ...state.skillStats,
            [an]: [...existing, { skillName: sn, count: 1 }],
          };
        }
        return { agentEvents: nextAgentEvents, skillStats: nextStats };
      }

      return { agentEvents: nextAgentEvents };
    }),

  setTaskPlan: (sessionId, planId, tasks) =>
    set((state) => ({
      taskPlans: {
        ...state.taskPlans,
        [sessionId]: { ...(state.taskPlans[sessionId] ?? {}), [planId]: tasks },
      },
      planSessionMap: { ...state.planSessionMap, [planId]: sessionId },
    })),

  removeTaskPlan: (sessionId, planId) =>
    set((state) => {
      const sessionPlans = { ...(state.taskPlans[sessionId] ?? {}) };
      delete sessionPlans[planId];
      const next = { ...state.taskPlans, [sessionId]: sessionPlans };
      if (Object.keys(sessionPlans).length === 0) delete next[sessionId];
      const nextMap = { ...state.planSessionMap };
      delete nextMap[planId];
      return { taskPlans: next, planSessionMap: nextMap };
    }),

  setPlanSummary: (sessionId, planId, summary) =>
    set((state) => ({
      planSummaries: {
        ...state.planSummaries,
        [sessionId]: { ...(state.planSummaries[sessionId] ?? {}), [planId]: summary },
      },
    })),

  addDiffCard: (sessionId, card) =>
    set((state) => ({
      diffCards: {
        ...state.diffCards,
        [sessionId]: [...(state.diffCards[sessionId] ?? []), card],
      },
    })),

  upsertDeploymentCard: (sessionId, card) =>
    set((state) => {
      const existing = state.deploymentCards[sessionId] ?? [];
      const index = existing.findIndex((item) => item.deploymentId === card.deploymentId);
      const nextCard: DeploymentCardState = index >= 0
        ? {
            ...existing[index],
            ...card,
            logs: card.log ? [...existing[index].logs, card.log] : existing[index].logs,
            updatedAt: card.timestamp || Date.now(),
          }
        : {
            deploymentId: card.deploymentId,
            target: card.target,
            status: card.status,
            logs: card.log ? [card.log] : [],
            url: card.url,
            imageSha: card.imageSha,
            buildTimeMs: card.buildTimeMs,
            error: card.error,
            updatedAt: card.timestamp || Date.now(),
          };
      return {
        deploymentCards: {
          ...state.deploymentCards,
          [sessionId]: index >= 0
            ? existing.map((item, itemIndex) => itemIndex === index ? nextCard : item)
            : [...existing, nextCard],
        },
      };
    }),

  addTestReport: (sessionId, report) =>
    set((state) => ({ testReports: { ...state.testReports, [sessionId]: [...(state.testReports[sessionId] ?? []), report] } })),

  addReviewReport: (sessionId, report) =>
    set((state) => ({ reviewReports: { ...state.reviewReports, [sessionId]: [...(state.reviewReports[sessionId] ?? []), report] } })),

  updateTaskStatus: (planId, taskId, status) =>
    set((state) => {
      const sessionId = state.planSessionMap[planId];
      if (!sessionId) return state;
      const tasks = state.taskPlans[sessionId]?.[planId];
      if (!tasks) return state;
      return {
        taskPlans: {
          ...state.taskPlans,
          [sessionId]: {
            ...(state.taskPlans[sessionId] ?? {}),
            [planId]: tasks.map((t) => t.taskId === taskId ? { ...t, status } : t),
          },
        },
      };
    }),

  updateTaskField: (planId, taskId, field, value) =>
    set((state) => {
      const sessionId = state.planSessionMap[planId];
      if (!sessionId) return state;
      const tasks = state.taskPlans[sessionId]?.[planId];
      if (!tasks) return state;
      const resolvedValue = field === 'dependsOn'
        ? (typeof value === 'string' ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : value)
        : value;
      return {
        taskPlans: {
          ...state.taskPlans,
          [sessionId]: {
            ...(state.taskPlans[sessionId] ?? {}),
            [planId]: tasks.map((t) =>
              t.taskId === taskId ? { ...t, [field]: resolvedValue } : t
            ),
          },
        },
      };
    }),

  setTaskAgent: (planId, taskId, agentId, agentName) =>
    set((state) => {
      const sessionId = state.planSessionMap[planId];
      if (!sessionId) return state;
      const tasks = state.taskPlans[sessionId]?.[planId];
      if (!tasks) return state;
      const task = tasks.find(t => t.taskId === taskId);
      if (!task) return state;
      return {
        taskPlans: {
          ...state.taskPlans,
          [sessionId]: {
            ...(state.taskPlans[sessionId] ?? {}),
            [planId]: tasks.map((t) => t.taskId === taskId
              ? { ...t, assignedAgentId: agentId, assignedAgentName: agentName, status: 'running' as const }
              : t),
          },
        },
        agentCurrentTask: {
          ...state.agentCurrentTask,
          [agentName]: { planId, taskId, title: task?.title || '' },
        },
        agentTaskCounts: {
          ...state.agentTaskCounts,
          [agentName]: Math.max(0, (state.agentTaskCounts[agentName] || 0) - 1),
        },
      };
    }),

  incrementUnread: (sessionId) =>
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [sessionId]: (state.unreadCounts[sessionId] || 0) + 1,
      },
    })),

  clearUnread: (sessionId) =>
    set((state) => ({
      unreadCounts: { ...state.unreadCounts, [sessionId]: 0 },
    })),

  clearSessionEvents: (sessionId) =>
    set((state) => {
      const msgIds = new Set((state.messages[sessionId] ?? []).map(m => m.id));
      const filtered: Record<string, AgentEvent[]> = {};
      for (const [msgId, events] of Object.entries(state.agentEvents)) {
        if (!msgIds.has(msgId)) filtered[msgId] = events;
      }
      return { agentEvents: filtered };
    }),

  addInboxNotification: (agentName) =>
    set((state) => ({
      inboxNotifications: {
        ...state.inboxNotifications,
        [agentName]: (state.inboxNotifications[agentName] || 0) + 1,
      },
    })),

  clearInboxNotifications: (agentName) =>
    set((state) => ({
      inboxNotifications: { ...state.inboxNotifications, [agentName]: 0 },
    })),

  addToast: (message, type = 'error') => {
    const id = 'toast-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    set((state) => ({
      toasts: [...state.toasts, { id, message, type }],
    }));
    // Auto-dismiss after 6 seconds
    setTimeout(() => {
      get().removeToast(id);
    }, 6000);
  },

  deleteMessage: (sessionId, msgId) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId] ?? [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: sessionMsgs.filter((m) => m.id !== msgId),
        },
      };
    }),

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  setRecoveryPlans: (sessionId, plans) =>
    set((state) => ({
      planRecoveries: { ...state.planRecoveries, [sessionId]: plans },
    })),

  removeRecoveryPlan: (sessionId, planId) =>
    set((state) => {
      const sessionRecoveries = state.planRecoveries[sessionId] ?? [];
      return {
        planRecoveries: {
          ...state.planRecoveries,
          [sessionId]: sessionRecoveries.filter(p => p.planId !== planId),
        },
      };
    }),
}));
