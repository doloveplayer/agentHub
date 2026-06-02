// Approval gate handlers.
// Extracted from handler.ts to keep modules focused.

import type { WebSocket } from 'ws';
import { getApprovalGate } from '../agent/ApprovalGate.js';
import { broadcast } from './state.js';

export function handleApprovalApprove(sessionId: string, _ws: WebSocket, data: { taskId: string; comment?: string }): void {
  const gate = getApprovalGate();
  const request = gate.approve(data.taskId, data.comment);
  if (request) {
    broadcast(sessionId, { type: "approval_resolved", taskId: data.taskId, approved: true, comment: data.comment });
  }
}

export function handleApprovalReject(sessionId: string, _ws: WebSocket, data: { taskId: string; comment?: string }): void {
  const gate = getApprovalGate();
  const request = gate.reject(data.taskId, data.comment);
  if (request) {
    broadcast(sessionId, { type: "approval_resolved", taskId: data.taskId, approved: false, comment: data.comment });
  }
}

export function handleApprovalReply(sessionId: string, _ws: WebSocket, data: { taskId: string; message: string }): void {
  const gate = getApprovalGate();
  const request = gate.addReply(data.taskId, "user", data.message);
  if (request) {
    broadcast(sessionId, {
      type: "approval_reply_added",
      taskId: data.taskId,
      approvalId: request.id,
      replies: request.replies,
    });
  }
}
