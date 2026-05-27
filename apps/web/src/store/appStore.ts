import { create } from 'zustand';
import type { Session, Message, AgentConfig } from '@agenthub/shared';

export interface AgentEvent {
  id: string;
  type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start' | 'subagent_result' | 'permission_request' | 'token_update';
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
    tokenUsage?: { input: number; output: number; cacheRead?: number; cacheCreate?: number; contextPct?: number };
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

export interface SecurityReportState {
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
  user: { id: string; login: string; avatarUrl: string } | null;
  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  agentEvents: Record<string, AgentEvent[]>;
  agents: AgentConfig[];
  streamingMessages: Record<string, string[]>;
  trustMode: boolean;
  sessionPermissionModes: Record<string, string>;
  orchestrationMode: 'parallel' | 'sequential';
  setOrchestrationMode: (mode: 'parallel' | 'sequential') => void;
  taskPlans: Record<string, TaskState[]>;
  planSummaries: Record<string, { total: number; completed: number; failed: number; fileChanges: string[]; timestamp: number }>;
  diffCards: Record<string, DiffCardState[]>;
  deploymentCards: Record<string, DeploymentCardState[]>;
  testReports: Record<string, TestReportState[]>;
  securityReports: Record<string, SecurityReportState[]>;
  reviewReports: Record<string, ReviewReportState[]>;
  setPlanSummary: (planId: string, summary: { total: number; completed: number; failed: number; fileChanges: string[]; timestamp: number }) => void;

  setToken: (token: string | null) => void;
  setUser: (user: any) => void;
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  setAgents: (agents: AgentConfig[]) => void;
  addMessage: (sessionId: string, msg: Message) => void;
  appendToMessage: (sessionId: string, msgId: string, chunk: string) => void;
  setMessageStatus: (sessionId: string, msgId: string, status: string) => void;
  addAgentEvent: (messageId: string, event: AgentEvent) => void;
  addStreamingMessage: (sessionId: string, msgId: string) => void;
  setTrustMode: (mode: boolean) => void;
  setSessionPermissionMode: (sessionId: string, mode: string) => void;
  updateSessionInList: (sessionId: string, updates: Partial<Session>) => void;
  removeStreamingMessage: (sessionId: string, msgId: string) => void;
  isSessionStreaming: (sessionId: string) => boolean;
  setTaskPlan: (planId: string, tasks: TaskState[]) => void;
  updateTaskStatus: (planId: string, taskId: string, status: TaskState['status']) => void;
  updateTaskField: (planId: string, taskId: string, field: string, value: any) => void;
  addDiffCard: (sessionId: string, card: DiffCardState) => void;
  upsertDeploymentCard: (sessionId: string, card: Omit<DeploymentCardState, 'logs' | 'updatedAt'> & { log?: string; timestamp?: number }) => void;
  addTestReport: (sessionId: string, report: TestReportState) => void;
  addSecurityReport: (sessionId: string, report: SecurityReportState) => void;
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
  streamingMessages: {},
  trustMode: true,
  sessionPermissionModes: {},
  orchestrationMode: 'parallel' as const,
  taskPlans: {},
  planSummaries: {},
  diffCards: {},
  deploymentCards: {},
  testReports: {},
  securityReports: {},
  reviewReports: {},
  agentCurrentTask: {},
  agentTaskCounts: {},
  unreadCounts: {},
  inboxNotifications: {},
  toasts: [],

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
      // Clear agent events from the previous session
      const msgIds = new Set((get().messages[prev] ?? []).map(m => m.id));
      const filtered: Record<string, AgentEvent[]> = {};
      for (const [msgId, evts] of Object.entries(get().agentEvents)) {
        if (!msgIds.has(msgId)) filtered[msgId] = evts;
      }
      set({ activeSessionId: id, agentEvents: filtered });
    } else {
      set({ activeSessionId: id });
    }
  },

  setAgents: (agents) => set({ agents }),

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

  appendToMessage: (sessionId, msgId, chunk) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId] ?? [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: sessionMsgs.map((m) =>
            m.id === msgId ? { ...m, content: m.content + chunk } : m
          ),
        },
      };
    }),

  setMessageStatus: (sessionId, msgId, status) =>
    set((state) => {
      const sessionMsgs = state.messages[sessionId] ?? [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: sessionMsgs.map((m) =>
            m.id === msgId ? { ...m, status: status as Message['status'] } : m
          ),
        },
      };
    }),

  addAgentEvent: (messageId, event) =>
    set((state) => ({
      agentEvents: {
        ...state.agentEvents,
        [messageId]: [...(state.agentEvents[messageId] ?? []), event],
      },
    })),

  setTaskPlan: (planId, tasks) =>
    set((state) => ({
      taskPlans: { ...state.taskPlans, [planId]: tasks },
    })),

  setPlanSummary: (planId, summary) =>
    set((state) => ({
      planSummaries: { ...state.planSummaries, [planId]: summary },
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

  addSecurityReport: (sessionId, report) =>
    set((state) => ({ securityReports: { ...state.securityReports, [sessionId]: [...(state.securityReports[sessionId] ?? []), report] } })),

  addReviewReport: (sessionId, report) =>
    set((state) => ({ reviewReports: { ...state.reviewReports, [sessionId]: [...(state.reviewReports[sessionId] ?? []), report] } })),

  updateTaskStatus: (planId, taskId, status) =>
    set((state) => {
      const tasks = state.taskPlans[planId];
      if (!tasks) return state;
      return {
        taskPlans: {
          ...state.taskPlans,
          [planId]: tasks.map((t) => t.taskId === taskId ? { ...t, status } : t),
        },
      };
    }),

  updateTaskField: (planId, taskId, field, value) =>
    set((state) => {
      const tasks = state.taskPlans[planId];
      if (!tasks) return state;
      const resolvedValue = field === 'dependsOn'
        ? (typeof value === 'string' ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : value)
        : value;
      return {
        taskPlans: {
          ...state.taskPlans,
          [planId]: tasks.map((t) =>
            t.taskId === taskId ? { ...t, [field]: resolvedValue } : t
          ),
        },
      };
    }),

  setTaskAgent: (planId, taskId, agentId, agentName) =>
    set((state) => {
      const tasks = state.taskPlans[planId];
      if (!tasks) return state;
      const task = tasks.find(t => t.taskId === taskId);
      return {
        taskPlans: {
          ...state.taskPlans,
          [planId]: tasks.map((t) => t.taskId === taskId
            ? { ...t, assignedAgentId: agentId, assignedAgentName: agentName, status: 'running' as const }
            : t),
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
}));
