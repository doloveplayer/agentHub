// Shared state and utilities for WebSocket handlers.
// Extracted from handler.ts to keep modules focused.

import { WebSocket } from 'ws';
import { SandboxManager } from '../agent/SandboxManager.js';
import { MilestoneBroadcaster } from '../agent/MilestoneBroadcaster.js';
import type { AbstractProvider } from '../agent/providers/base.js';

// ---- State Maps ----

/** sessionId → set of connected WebSockets */
export const sessions = new Map<string, Set<WebSocket>>();

/** sessionId → active agent info (process + timer) */
export interface AgentProcess {
  process: { write(input: string): void; kill?(): void; stop?(): void };
  timer: NodeJS.Timeout;
  agentId: string;
  agentName?: string;
}
export const agentStates = new Map<string, Map<string, AgentProcess>>();

/** sessionId → Map<agentName → REPL process info> */
export const agentProcesses = new Map<string, Map<string, {
  provider: AbstractProvider; timer: NodeJS.Timeout; agentId: string;
}>>();

/** sessionId → sandbox info */
export const sandboxes = new Map<string, { containerId: string; workDir: string; hostWorkDir: string }>();

/** Count of currently executing agents */
export let runningAgentCount = 0;
export function incRunningAgentCount(): void { runningAgentCount++; }
export function decRunningAgentCount(): void { runningAgentCount = Math.max(0, runningAgentCount - 1); }

/** Sessions with milestone broadcasting */
export const sessionsWithMilestones = new Set<string>();

/** Sequential orchestration queues */
export const sequentialQueues = new Map<string, { agentId: string; subPrompt: string; messageId: string }[]>();

/** Task dispatch state */
export interface TaskDispatchNode {
  id: string;
  title: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  expectedOutput: string;
  priority: 'high' | 'medium' | 'low';
}
export interface AgentTaskQueue {
  planId: string;
  sessionId: string;
  tasks: TaskDispatchNode[];
  current: TaskDispatchNode | null;
  sandbox: { containerId: string; workDir: string; hostWorkDir: string };
}
export const agentTaskQueues = new Map<string, AgentTaskQueue>();
export const agentCurrentTask = new Map<string, { planId: string; taskId: string }>();

/** REPL event routing: agentName → current messageId */
export const agentCurrentMessage = new Map<string, string>();

/** Permission timeouts */
export const permissionTimeouts = new Map<string, NodeJS.Timeout>();
export const PERMISSION_TIMEOUT_MS = 120_000;
// REPL mode disabled: `cat file - | claude` blocks on spawn's stdin pipe
// which never receives EOF. Use one-shot ClaudeCodeProcess (--print mode) instead.
// Re-enable after implementing PTY-based stdin or docker exec send mechanism.
export const ENABLE_PERSISTENT_REPL = false;

/** TaskQueueManager reference (set by index.ts) */
export let taskQueueManager: any = null;
export function setTaskQueueManager(tqm: any): void { taskQueueManager = tqm; }

/** Plan confirmation: planId:taskId → modified description */
export const taskModifications = new Map<string, string>();

/** agentName → Claude Code session ID (for --resume across one-shot turns) */
export const agentClaudeSessions = new Map<string, string>();

// ---- Conflict detection ----

const perSessionFileMods = new Map<string, Map<string, Set<string>>>();

export function trackFileMod(sessionId: string, agentName: string, filePath: string): Set<string> {
  if (!perSessionFileMods.has(sessionId)) perSessionFileMods.set(sessionId, new Map());
  const fileMap = perSessionFileMods.get(sessionId)!;
  if (!fileMap.has(filePath)) fileMap.set(filePath, new Set());
  return fileMap.get(filePath)!.add(agentName);
}

export function detectConflicts(sessionId: string): { filePath: string; agents: string[] }[] {
  const fileMap = perSessionFileMods.get(sessionId);
  if (!fileMap) return [];
  const conflicts: { filePath: string; agents: string[] }[] = [];
  for (const [filePath, agents] of fileMap) {
    if (agents.size > 1) conflicts.push({ filePath, agents: [...agents] });
  }
  return conflicts;
}

export function clearFileMods(sessionId: string): void {
  perSessionFileMods.delete(sessionId);
}

// ---- Utilities ----

export function generateId(): string {
  return crypto.randomUUID();
}

export async function getOrCreateSandbox(sessionId: string) {
  let sandbox = sandboxes.get(sessionId);
  if (!sandbox) {
    sandbox = await SandboxManager.create(sessionId);
    sandboxes.set(sessionId, sandbox);
  }
  return sandbox;
}

export function broadcast(sessionId: string, data: unknown): void {
  const conns = sessions.get(sessionId);
  if (!conns) return;
  const payload = JSON.stringify(data);
  for (const ws of conns) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export function sendTo(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

export function cleanupSessionResources(sessionId: string): void {
  const procMap = agentProcesses.get(sessionId);
  if (procMap) {
    for (const [agentName, info] of procMap) {
      clearTimeout(info.timer);
      info.provider.stop();
      agentCurrentMessage.delete(agentName);
    }
    agentProcesses.delete(sessionId);
  }

  MilestoneBroadcaster.clear(sessionId);
  sessionsWithMilestones.delete(sessionId);
  clearFileMods(sessionId);

  // Clean up Claude session IDs for agents in this session
  if (procMap) { for (const [agentName] of procMap) agentClaudeSessions.delete(agentName); }

  const stateMap = agentStates.get(sessionId);
  if (stateMap) {
    for (const [pid, timeout] of permissionTimeouts) {
      const agentMsgId = pid.split('|::|')[0];
      if (stateMap.has(agentMsgId)) { clearTimeout(timeout); permissionTimeouts.delete(pid); }
    }
    for (const [msgId, state] of stateMap) {
      clearTimeout(state.timer);
      if (state.process.kill) state.process.kill(); else if (state.process.stop) state.process.stop();
      decRunningAgentCount();
    }
    agentStates.delete(sessionId);
  }

  const sandbox = sandboxes.get(sessionId);
  if (sandbox) {
    SandboxManager.destroy(sandbox.containerId).catch((err) =>
      console.error(`[ws] Failed to destroy container: ${err.message}`));
    SandboxManager.destroyHostDir(sessionId);
    sandboxes.delete(sessionId);
    console.log(`[ws] Sandbox cleaned: session=${sessionId}`);
  }

  sessions.delete(sessionId);
}

export function cleanupSessionClient(sessionId: string, ws: WebSocket): void {
  const conns = sessions.get(sessionId);
  if (!conns) return;
  conns.delete(ws);
  if (conns.size > 0) return;
  console.log(`[ws] Last client left session=${sessionId}, cleaning up...`);
  cleanupSessionResources(sessionId);
}

export function clearRunningAgent(sessionId: string, agentMessageId: string): void {
  const stateMap = agentStates.get(sessionId);
  if (!stateMap) return;
  const st = stateMap.get(agentMessageId);
  if (st) { clearTimeout(st.timer); stateMap.delete(agentMessageId); decRunningAgentCount(); }
  if (stateMap.size === 0) agentStates.delete(sessionId);
}
