/**
 * ApprovalGate: pauses DAG execution for human review of agent outputs.
 *
 * Based on HiveWard's AgentApprovalConfig + waiting_approval workflow.
 * When a task node has requiresApproval=true, its output is held here
 * until a human approves, rejects, or replies (triggering agent re-execution).
 */

export interface ApprovalRequest {
  id: string;
  planId: string;
  taskId: string;
  agentName: string;
  output: unknown;
  replies: ApprovalReply[];
  status: "waiting" | "approved" | "rejected";
  selectedReplyId?: string;
  createdAt: string;
}

export interface ApprovalReply {
  id: string;
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

export interface ApprovalResult {
  approved: boolean;
  comment?: string;
  output?: unknown;
}

let _seq = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_seq}`;
}

export class ApprovalGate {
  private pending = new Map<string, ApprovalRequest>();  // taskId → request
  private resolvers = new Map<string, (result: ApprovalResult) => void>();

  submit(
    taskId: string,
    planId: string,
    agentName: string,
    output: unknown,
  ): ApprovalRequest {
    const request: ApprovalRequest = {
      id: nextId("approval"),
      planId,
      taskId,
      agentName,
      output,
      replies: [],
      status: "waiting",
      createdAt: new Date().toISOString(),
    };
    this.pending.set(taskId, request);
    return request;
  }

  /** Returns a promise that resolves when a human makes a decision */
  waitForDecision(taskId: string): Promise<ApprovalResult> {
    // Clean up any stale resolver
    this.resolvers.delete(taskId);
    return new Promise((resolve) => {
      this.resolvers.set(taskId, resolve);
    });
  }

  approve(taskId: string, comment?: string): ApprovalRequest | undefined {
    const request = this.pending.get(taskId);
    if (!request) return undefined;
    request.status = "approved";
    const resolve = this.resolvers.get(taskId);
    if (resolve) {
      resolve({ approved: true, comment, output: request.output });
      this.resolvers.delete(taskId);
    }
    return request;
  }

  reject(taskId: string, comment?: string): ApprovalRequest | undefined {
    const request = this.pending.get(taskId);
    if (!request) return undefined;
    request.status = "rejected";
    const resolve = this.resolvers.get(taskId);
    if (resolve) {
      resolve({ approved: false, comment });
      this.resolvers.delete(taskId);
    }
    return request;
  }

  addReply(taskId: string, role: "user" | "assistant", body: string): ApprovalRequest | undefined {
    const request = this.pending.get(taskId);
    if (!request) return undefined;
    request.replies.push({
      id: nextId("reply"),
      role,
      body,
      createdAt: new Date().toISOString(),
    });
    return request;
  }

  getPending(taskId: string): ApprovalRequest | undefined {
    return this.pending.get(taskId);
  }

  listPending(planId?: string): ApprovalRequest[] {
    const all = [...this.pending.values()];
    if (planId) return all.filter(r => r.planId === planId);
    return all;
  }

  /** Remove request from tracking (cleanup after decision processed) */
  remove(taskId: string): void {
    this.pending.delete(taskId);
    this.resolvers.delete(taskId);
  }
}

/** Singleton */
let _gate: ApprovalGate | null = null;
export function getApprovalGate(): ApprovalGate {
  if (!_gate) _gate = new ApprovalGate();
  return _gate;
}
