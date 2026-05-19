import { create } from 'zustand';
import type { Session, Message, AgentConfig } from '@agenthub/shared';

export interface AgentEvent {
  id: string;
  type: 'thinking' | 'tool_use' | 'tool_result' | 'subagent_start' | 'subagent_result' | 'permission_request';
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
  removeStreamingMessage: (sessionId: string, msgId: string) => void;
  isSessionStreaming: (sessionId: string) => boolean;
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

  setToken: (token) => {
    if (token) localStorage.setItem('agenthub_token', token);
    else localStorage.removeItem('agenthub_token');
    set({ token });
  },

  setUser: (user) => set({ user }),

  setSessions: (sessions) => set({ sessions }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  setAgents: (agents) => set({ agents }),

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
}));