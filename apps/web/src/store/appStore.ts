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
    tokenUsage?: { input: number; output: number };
  };
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
  orchestrationMode: 'parallel' | 'sequential';
  setOrchestrationMode: (mode: 'parallel' | 'sequential') => void;
  taskPlans: Record<string, TaskState[]>;
  planSummaries: Record<string, { total: number; completed: number; failed: number; fileChanges: string[]; timestamp: number }>;
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
  removeStreamingMessage: (sessionId: string, msgId: string) => void;
  isSessionStreaming: (sessionId: string) => boolean;
  setTaskPlan: (planId: string, tasks: TaskState[]) => void;
  updateTaskStatus: (planId: string, taskId: string, status: TaskState['status']) => void;
  unreadCounts: Record<string, number>;
  incrementUnread: (sessionId: string) => void;
  clearUnread: (sessionId: string) => void;
}

export interface TaskState {
  taskId: string;
  planId: string;
  title: string;
  agentType: string;
  status: 'waiting' | 'running' | 'done' | 'failed';
  dependsOn: string[];
  progress?: { completed: number; total: number };
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
  orchestrationMode: 'parallel' as const,
  taskPlans: {},
  planSummaries: {},
  unreadCounts: {},

  setToken: (token) => {
    if (token) localStorage.setItem('agenthub_token', token);
    else localStorage.removeItem('agenthub_token');
    set({ token });
  },

  setUser: (user) => set({ user }),

  setSessions: (sessions) => set({ sessions }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  setAgents: (agents) => set({ agents }),

  setTrustMode: (trustMode) => set({ trustMode }),
  setOrchestrationMode: (orchestrationMode) => set({ orchestrationMode }),

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
}));