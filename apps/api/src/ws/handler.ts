// WebSocket connection lifecycle, message routing, and server attachment.
// Chat, plan, approval, and deploy handlers are in separate modules.

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { isDeployTarget, normalizeTarget, startDeployment } from '../routes/deploy.js';
import { permissionProfiles, type AgentCapability } from '../agent/PermissionProfiles.js';

import {
  sessions, sessionPermissionModes, sandboxes,
  pendingAgentQueue,
  broadcast, sendTo,
  cleanupSessionClient,
  realWorkspacePaths, workspaceModes,
} from './state.js';

import {
  handleChatMessage,
  handleStopAgent,
  handlePermissionResponse,
  handlePermissionModeChange,
  agentNameToType,
  sessionTypes,
  sandboxInitialized,
} from './chatHandlers.js';

import {
  handleConfirmPlan,
  handlePlanConfirm,
  handlePlanCancel,
  handleModifyTask,
  handleRetryTask,
  handleReplanRequest,
  handleForceCompleteTaskMsg,
  handleForceFailTaskMsg,
} from './planHandlers.js';

import {
  handleApprovalApprove,
  handleApprovalReject,
  handleApprovalReply,
} from './approvalHandlers.js';

export { broadcast } from './state.js';

// ---- Connection handler ----

function buildProfileFromAgent(agent: { name: string; description?: string; capabilities?: unknown }): Partial<AgentCapability> {
  if (agent.capabilities && typeof agent.capabilities === 'object') {
    return agent.capabilities as Partial<AgentCapability>;
  }
  return {};
}

const POLICY_VIOLATION_CLOSE_CODE = 1008;

async function handleConnection(ws: WebSocket, request: any) {
  const url = new URL(request.url || '/', `http://${request.headers?.host || 'localhost'}`);
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('sessionId');

  if (!token || !sessionId) {
    sendTo(ws, { type: 'error', message: 'Missing token or sessionId' });
    ws.close(POLICY_VIOLATION_CLOSE_CODE, 'Missing token or sessionId');
    return;
  }

  let userId: string;
  try {
    const payload = verifyToken(token);
    userId = payload.userId;
  } catch {
    sendTo(ws, { type: 'error', message: 'Invalid token' });
    ws.close(POLICY_VIOLATION_CLOSE_CODE, 'Invalid token');
    return;
  }

  // Register message handler FIRST — before any async DB queries.
  const earlyMessages: { data: any }[] = [];
  let sandboxReady = false;
  let sessionType: string | null = null;
  ws.on('message', (raw) => {
    let data: any;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!sandboxReady) { earlyMessages.push({ data }); return; }
    handleMessage(ws, sessionId, data);
  });
  ws.on('close', () => { sandboxInitialized.delete(sessionId); cleanupSessionClient(sessionId, ws); });
  ws.on('error', () => { sandboxInitialized.delete(sessionId); cleanupSessionClient(sessionId, ws); });

  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      sendTo(ws, { type: 'error', message: 'User not found — please re-authenticate' });
      ws.close(4001, 'User not found');
      return;
    }
  } catch {
    sendTo(ws, { type: 'error', message: 'Failed to verify user' });
    ws.close(4000, 'Internal error');
    return;
  }

  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        permissionMode: true,
        type: true,
        workspacePath: true,
        workspaceMode: true,
        writePermission: true,
      },
    });
    if (!session || session.userId !== userId) {
      sendTo(ws, { type: 'error', message: 'Session not found or access denied' });
      ws.close(4003, 'Access denied');
      return;
    }
    sessionPermissionModes.set(sessionId, session.permissionMode || 'ask');
    sessionTypes.set(sessionId, session.type);
    sessionType = session.type;

    // Load workspace configuration from database
    if (session.workspacePath) {
      realWorkspacePaths.set(sessionId, session.workspacePath);
      workspaceModes.set(sessionId, (session.workspaceMode as any) || 'custom');
    }
  } catch {
    sendTo(ws, { type: 'error', message: 'Failed to verify session' });
    ws.close(4000, 'Internal error');
    return;
  }

  if (!sessions.has(sessionId)) sessions.set(sessionId, new Set());
  sessions.get(sessionId)!.add(ws);

  // Sandbox creation is deferred to first chat message (ensureSandboxReady)
  // so the user can configure a workspace path before the container bind mount is set.

  console.log(`[ws] Client connected: session=${sessionId} userId=${userId}`);
  sendTo(ws, { type: 'connected', sessionId });

  // Recover in-flight plan executions after backend restart
  try {
    const { DagPersistence } = await import('../agent/DagPersistence.js');
    const plans = await DagPersistence.recover(sessionId);
    for (const plan of plans) {
      broadcast(sessionId, {
        type: 'plan_recovered',
        planId: plan.planId,
        planTitle: plan.planTitle,
        status: plan.status,
        tasks: plan.tasks.map((t) => ({
          taskId: t.id,
          planId: plan.planId,
          title: t.title,
          agentType: t.agentType,
          status: t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : t.status === 'blocked' ? 'blocked' : 'waiting',
          dependsOn: t.dependsOn,
          expectedOutput: t.expectedOutput,
          priority: t.priority,
          assignedAgentName: t.agentName,
          assignedAgentId: t.agentId,
          description: t.description,
        })),
      });
    }
    if (plans.length > 0) {
      console.log(`[ws] Recovered ${plans.length} plan(s) for session=${sessionId.slice(0, 8)}`);
    }
  } catch (err: any) {
    console.log(`[ws] Plan recovery skipped: ${err.message}`);
  }

  // Register agent permission profiles for this session
  try {
    const sessionAgentsForProfiles = await prisma.sessionAgent.findMany({
      where: { sessionId },
      include: { agent: { select: { id: true, name: true, displayName: true, description: true } } },
    });
    for (const sa of sessionAgentsForProfiles) {
      const profile = buildProfileFromAgent(sa.agent);
      permissionProfiles.register(sa.agent.name, profile);
      agentNameToType.set(sa.agent.name, sa.agent.name);
    }
  } catch (err: any) {
    console.log(`[ws] Profile registration skipped: ${err.message}`);
  }

  // Flush early messages that arrived before sandbox was ready
  sandboxReady = true;
  if (earlyMessages.length > 0) {
    console.log(`[ws] Flushing ${earlyMessages.length} early message(s) for session=${sessionId.slice(0,8)}`);
    for (const em of earlyMessages) handleMessage(ws, sessionId, em.data);
    earlyMessages.length = 0;
  }
}

// ---- Message routing ----

function handleMessage(ws: WebSocket, sessionId: string, data: any): void {
  switch (data.type) {
    case 'chat':       handleChatMessage(sessionId, data); break;
    case 'permission_response': handlePermissionResponse(sessionId, data); break;
    case 'permission_mode_change': handlePermissionModeChange(sessionId, data); break;
    case 'stop_agent': handleStopAgent(sessionId, data); break;
    case 'confirm_plan': handleConfirmPlan(sessionId, data); break;
    case 'plan_confirm': handlePlanConfirm(sessionId, data); break;
    case 'plan_cancel': handlePlanCancel(sessionId, data); break;
    case 'deploy_to_platform': handleDeployToPlatform(sessionId, data); break;
    case 'modify_task': handleModifyTask(sessionId, data); break;
    case 'retry_task': handleRetryTask(sessionId, data); break;
    case 'replan_failed_task': handleReplanRequest(sessionId, data); break;
    case 'force_complete_task': handleForceCompleteTaskMsg(sessionId, data); break;
    case 'force_fail_task': handleForceFailTaskMsg(sessionId, data); break;
    case 'approval_approve': handleApprovalApprove(sessionId, ws, data); break;
    case 'approval_reject': handleApprovalReject(sessionId, ws, data); break;
    case 'approval_reply': handleApprovalReply(sessionId, ws, data); break;
    case 'recover_plan': handleRecoverPlan(sessionId, data, ws); break;
    case 'discard_plan': handleDiscardPlan(sessionId, data, ws); break;
    default: sendTo(ws, { type: 'error', message: `Unknown message type: ${data.type}` });
  }
}

function handleDeployToPlatform(sessionId: string, data: { target?: string; production?: boolean; confirmPhrase?: string }): void {
  const sandbox = sandboxes.get(sessionId);
  if (!sandbox) { broadcast(sessionId, { type: 'stream_error', error: 'No active sandbox' }); return; }
  if (data.target !== undefined && !isDeployTarget(data.target)) {
    broadcast(sessionId, { type: 'deployment_status', deploymentId: `dep-${Date.now()}`, target: String(data.target), status: 'failed', error: 'Invalid deploy target', timestamp: Date.now() });
    return;
  }
  const target = normalizeTarget(data.target);
  if (data.production && data.confirmPhrase !== `DEPLOY ${target.toUpperCase()}`) {
    broadcast(sessionId, { type: 'deployment_status', deploymentId: `dep-${Date.now()}`, target, status: 'failed', error: `Confirmation phrase must be DEPLOY ${target.toUpperCase()}`, timestamp: Date.now() });
    return;
  }
  startDeployment(sessionId, sandbox.hostWorkDir, target);
}

// ---- Plan recovery ----

/** Pending recovery checkpoints, keyed by sessionId:planId. Stored on reconnect for user decision. */
export const pendingRecoveries = new Map<string, { planId: string; pendingTasks: any[] }>();

function handleRecoverPlan(sessionId: string, data: { planId: string }, ws: WebSocket): void {
  const key = `${sessionId}:${data.planId}`;
  const recovery = pendingRecoveries.get(key);
  if (!recovery) {
    sendTo(ws, { type: 'stream_error', error: `Recovery data not found for plan ${data.planId}` });
    return;
  }
  const sb = sandboxes.get(sessionId);
  if (!sb) {
    sendTo(ws, { type: 'stream_error', error: 'No active sandbox' });
    return;
  }

  console.log(`[recovery] User confirmed — re-dispatching plan ${data.planId}`);
  import('./taskDispatcher.js').then(({ enqueueTaskAssignments }) => {
    enqueueTaskAssignments(sessionId, data.planId, recovery.pendingTasks.map((t: any) => ({
      task: { ...t, priority: t.priority || 'medium' },
      agentName: t.agentType,
      agentId: '',
    })), sb).catch((err: any) =>
      console.error(`[recovery] Re-dispatch failed: ${err.message}`)
    );
  }).catch((err: any) => console.error('[recovery] Task dispatcher import failed:', err.message));

  pendingRecoveries.delete(key);
  broadcast(sessionId, { type: 'plan_recovery_confirmed', planId: data.planId });
}

function handleDiscardPlan(sessionId: string, data: { planId: string }, ws: WebSocket): void {
  const key = `${sessionId}:${data.planId}`;
  const recovery = pendingRecoveries.get(key);
  if (!recovery) {
    sendTo(ws, { type: 'stream_error', error: `Recovery data not found for plan ${data.planId}` });
    return;
  }

  console.log(`[recovery] User discarded plan ${data.planId}`);
  pendingRecoveries.delete(key);

  // Clean up checkpoint and mark plan as failed
  import('../agent/DagPersistence.js').then(({ DagPersistence }) => {
    DagPersistence.markFailed(sessionId, data.planId).catch(() => {});
  }).catch(() => {});

  broadcast(sessionId, { type: 'plan_recovery_discarded', planId: data.planId });
}

// ---- Attach to HTTP server ----

let heartbeatInterval: NodeJS.Timeout | null = null;

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws: WebSocket, request) => handleConnection(ws, request));
  console.log('[ws] WebSocket server attached on /ws');

  // Queue heartbeat: send position updates every 10s to sessions with queued agents.
  // Clear any previous interval (e.g., during HMR or integration tests) to avoid leaks.
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (pendingAgentQueue.length === 0) return;
    const now = Date.now();
    for (let i = 0; i < pendingAgentQueue.length; i++) {
      const req = pendingAgentQueue[i];
      const waitMs = now - req.enqueuedAt;
      broadcast(req.sessionId, {
        type: 'agent_queue_heartbeat',
        agentMessageId: req.mention.messageId,
        position: i + 1,
        totalQueued: pendingAgentQueue.length,
        waitSeconds: Math.round(waitMs / 1000),
        timestamp: now,
      });
    }
  }, 10_000);
}

/** Stop the queue heartbeat interval (for graceful shutdown / testing). */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function handleWebSocket(ws: WebSocket, request: any): void {
  handleConnection(ws, request);
}
