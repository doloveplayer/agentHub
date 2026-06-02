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

export type WorkspaceMode = 'read_only_default' | 'full_access' | 'sandbox' | 'custom';
export type WritePermission = 'ask' | 'auto';

export interface WorkspaceConfig {
  path: string | null;
  mode: WorkspaceMode;
  writePermission: WritePermission;
}

export interface Session {
  id: string;
  title: string;
  type?: 'solo' | 'group';
  userId: string;
  sandboxContainerId?: string;
  permissionMode?: PermissionMode;
  workspacePath?: string | null;
  workspaceMode?: WorkspaceMode;
  writePermission?: WritePermission;
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
  // Token usage (agent responses only)
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

export interface SessionAgentStats {
  agentId: string;
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  messageCount: number;
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
  type?: 'user' | 'system';
  createdBy?: string | null;
  skills?: SkillDef[] | null;
}

export interface SkillDef {
  name: string;
  description: string;
  content: string;
}

export interface SkillValidationResult {
  valid: boolean;
  skill?: SkillDef;
  errors?: Array<{ field: string; message: string }>;
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
  quoteReferenceId?: string | null;
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

/** Skill-driven plan types — single source of truth for plan.json schema */
export interface PlanTask {
  id: string;
  title: string;
  description: string;
  agentType: string;       // matches cap-inventory values, not enum-constrained
  dependsOn: string[];
  expectedOutput: string;
  risk: "low" | "high";
}

export interface Plan {
  planTitle: string;
  summary: string;
  tasks: PlanTask[];
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

// ---- Context Bus ----

export type ContextEntryType =
  | 'known-issue'
  | 'project-fact'
  | 'task-handoff'
  | 'decision'
  | 'artifact'
  | 'convention'
  | 'dependency-map';

export type ContextEntryStatus = 'active' | 'resolved' | 'superseded';

export interface ContextEntry {
  key: string;
  value: unknown;
  type: ContextEntryType;
  version: number;
  author: string;
  taskId?: string;
  planId?: string;
  tags: string[];
  status: ContextEntryStatus;
  createdAt: number;
  updatedAt: number;
}

// ---- Archive ----

export interface ArchiveManifest {
  planId: string;
  sessionId: string;
  planTitle: string;
  completedAt: string;
  durationMs: number;
  tasks: Array<{
    id: string;
    title: string;
    agentType: string;
    status: string;
    outputFiles: string[];
    modifiedFiles: string[];
    outputSummary: string;
  }>;
  fileChanges: {
    added: string[];
    modified: string[];
    removed: string[];
  };
  contextEntries: Array<{
    key: string;
    type: ContextEntryType;
    status: ContextEntryStatus;
  }>;
}

export type ExperienceType =
  | 'bug-pattern'
  | 'project-convention'
  | 'strategy-outcome'
  | 'dependency-topology'
  | 'domain-knowledge'
  | 'tool-pitfall';

export interface ExperienceEntry {
  type: ExperienceType;
  title: string;
  detail: string;
  agentTypes: string[];
  tags: string[];
  sourcePlan?: string;
  sourceTask?: string;
  severity: 'high' | 'medium' | 'low';
}

// ---- Checkpoint ----

export interface AgentSessionState {
  claudeSessionId: string;
  lastTaskId: string;
  status: 'idle' | 'running';
}

export interface PlanCheckpoint {
  planId: string;
  sessionId: string;
  workspaceGitCommit?: string;
  contextBusState: string;
  agentSessions: Record<string, AgentSessionState>;
  pendingTasks: Array<{
    id: string;
    title: string;
    description: string;
    agentType: string;
    dependsOn: string[];
    expectedOutput: string;
    priority: string;
  }>;
  completedTasks: string[];
  failedTasks: Array<{
    id: string;
    error: string;
    retryCount: number;
  }>;
  timestamp: number;
}

// ---- Skill Stats ----

export interface SkillUsageRecord {
  skillName: string;
  agentName: string;
  agentId: string;
  count: number;
  firstUsed: number;
  lastUsed: number;
  associatedTaskIds: string[];
}

export interface SkillUseEvent {
  type: 'skill_use';
  skillName: string;
  agentName: string;
  agentId: string;
  taskId?: string;
  planId?: string;
  timestamp: number;
}

// ---- Session Communication Log ----

export type CommLogCategory = 'contextbus' | 'inbox' | 'task' | 'plan' | 'agent';

export interface CommLogEntry {
  ts: number;
  category: CommLogCategory;
  action: string;
  sessionId: string;
  payload: Record<string, unknown>;
}
