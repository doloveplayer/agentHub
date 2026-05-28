export interface User {
  id: string;
  username: string;
  avatarUrl: string;
  email?: string;
}

export type PermissionMode = 'read_only' | 'ask' | 'smart' | 'trust';

export type AgentProvider = 'claude-code' | 'codex';

export interface AgentProviderConfig {
  model?: string;
  endpoint?: string;
  allowedTools?: string[];
  forbiddenTools?: string[];
  skills?: string[];
  [key: string]: unknown;
}

export type WorkspaceMode = 'read_only_default' | 'full_access';

export interface Session {
  id: string;
  title: string;
  type?: 'solo' | 'group';
  userId: string;
  sandboxContainerId?: string;
  permissionMode?: PermissionMode;
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
  status: 'sending' | 'queued' | 'streaming' | 'done' | 'error';
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  provider?: AgentProvider;
  providerConfig?: AgentProviderConfig | null;
  capabilities?: Record<string, unknown> | null;
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

export interface PermissionRequest {
  permissionId: string;
  tool: string;
  path?: string;
  agentMessageId: string;
  timestamp: number;
}

export interface PermissionResponse {
  permissionId: string;
  allowed: boolean;
  message?: string;
}

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  agentType: 'code-agent' | 'review-agent' | 'test-agent';
  dependsOn: string[];
  expectedOutput: string;
  priority: 'high' | 'medium' | 'low';
  requiresApproval?: boolean;
}

export interface TaskPlan {
  planTitle: string;
  summary: string;
  tasks: TaskNode[];
}

export interface TaskPlanResult {
  planId: string;
  userId: string;
  sessionId: string;
  plan: TaskPlan;
  status: 'pending_confirmation' | 'executing' | 'completed' | 'failed';
  createdAt: string;
}

export interface DeploymentStatusEvent {
  type: 'deployment_status';
  deploymentId: string;
  target: 'docker' | 'vercel' | 'cloudflare';
  status: 'queued' | 'building' | 'deploying' | 'success' | 'rolling_back' | 'failed';
  log?: string;
  url?: string;
  buildTimeMs?: number;
  imageSha?: string;
  error?: string;
  timestamp: number;
}

export interface DeployToPlatformEvent {
  type: 'deploy_to_platform';
  target: 'docker' | 'vercel' | 'cloudflare';
  production?: boolean;
  confirmPhrase?: string;
}

export interface ReplanFailedTaskRequest {
  type: 'replan_failed_task';
  planId: string;
  taskId: string;
}

export interface ReplanFailedTaskResult {
  type: 'replan_result';
  planId: string;
  taskId: string;
  action: 'continue' | 'replan' | 'abort';
  reason: string;
  nextTasks?: TaskNode[];
}

export interface SessionRenamedEvent {
  type: 'session_renamed';
  sessionId: string;
  oldTitle: string;
  newTitle: string;
  timestamp: number;
}

export interface WorkspaceChangedEvent {
  type: 'workspace_changed';
  sessionId: string;
  path: string;
  mode: WorkspaceMode;
  timestamp: number;
}
