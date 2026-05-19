export interface User {
  id: string;
  githubId: number;
  login: string;
  avatarUrl: string;
  email?: string;
}

export interface Session {
  id: string;
  title: string;
  type?: 'solo' | 'group';
  userId: string;
  sandboxContainerId?: string;
  agents?: SessionAgentInfo[];
  lastMessage?: { id: string; content: string; senderType: string; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionAgentInfo {
  agentId: string;
  name: string;
  displayName: string;
}

export interface Message {
  id: string;
  sessionId: string;
  senderType: 'human' | 'agent';
  agentId?: string;
  content: string;
  status: 'sending' | 'streaming' | 'done' | 'error';
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
}

export interface Mention {
  agentId: string;
  agentName: string;
  subPrompt: string;
}

export interface SendRequest {
  sessionId: string;
  content: string;
  mentions?: Mention[];
}

export interface SendResponse {
  userMessageId: string;
  agentMessages: { agentMessageId: string; agentId: string }[];
}
