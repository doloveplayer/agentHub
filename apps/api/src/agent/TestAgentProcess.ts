import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'path';
import type { ParsedEvent } from './EventParser.js';

export type TestAgentEventHandler = (event: ParsedEvent) => void;

const PERMISSION_HINT_RE = /permission|权限|write|edit|写文件|修改文件|保存文件|创建文件/i;
const TOOL_HINT_RE = /tool|工具|read|读取|检查文件|分析文件/i;
const SUBAGENT_HINT_RE = /subagent|子agent|子 agent|并行分析|复杂分析/i;
const LONG_TASK_HINT_RE = /long|timeout|stop|长任务|持续输出|不要停止/i;
const START_ERROR_HINT_RE = /mock-start-error|start error|启动失败/i;
const PLANNER_HINT_RE = /planner|\/plan|任务拆解|生成计划|task dag|dag/i;
const DAG_TASK_HINT_RE = /mock-dag-(?:success|fail|fail-once|delay)/i;
const DAG_DELAY_RE = /mock-dag-delay:(\d+)/i;
const DAG_FAIL_RE = /mock-dag-fail(?!-once)/i;
const DAG_FAIL_ONCE_RE = /mock-dag-fail-once/i;
const HIGH_CHUNK_HINT_RE = /mock-high-chunk:(\d+)/i;
const LATE_CHUNK_HINT_RE = /mock-late-chunk/i;
const ERROR_SECRET_HINT_RE = /mock-error-secret/i;
const STOP_VERIFY_HINT_RE = /mock-stop-verify/i;
const NO_SANDBOX_HINT_RE = /mock-no-sandbox/i;
const QUEUE_HINT_RE = /mock-queue-test/i;
const dagTaskAttempts = new Map<string, number>();
let globalRunningCount = 0;

export class TestAgentProcess {
  private handlers: TestAgentEventHandler[] = [];
  private timers = new Set<NodeJS.Timeout>();
  private killed = false;
  private pendingPermission: { hostWorkDir?: string; path: string; content: string } | null = null;
  onClaudeSession?: (sessionId: string) => void;

  onEvent(handler: TestAgentEventHandler): void {
    this.handlers.push(handler);
  }

  async start(
    sessionId: string,
    prompt: string,
    _containerId: string,
    _workDir: string,
    trustMode = true,
    hostWorkDir?: string,
    promptFileId?: string,
    _claudeSessionId?: string,
    agentConfigId?: string,
  ): Promise<void> {
    this.reset();

    const focusedPrompt = extractUserRequest(prompt);

    if (START_ERROR_HINT_RE.test(focusedPrompt)) {
      throw new Error('Mock provider start error');
    }

    const mockSessionId = `mock-${sessionId}-${agentConfigId || promptFileId || 'agent'}`;
    this.onClaudeSession?.(mockSessionId);
    this.schedule(0, () => this.emit({ type: 'system', subtype: 'init', message: 'mock provider ready', sessionId: mockSessionId }));

    if (LONG_TASK_HINT_RE.test(focusedPrompt)) {
      this.schedule(10, () => this.emit({ type: 'text', content: 'Mock long task started.\n' }));
      const interval = setInterval(() => {
        if (this.killed) {
          clearInterval(interval);
          return;
        }
        this.emit({ type: 'text', content: 'Mock long task heartbeat.\n' });
      }, 250);
      this.timers.add(interval);
      return;
    }

    if (DAG_TASK_HINT_RE.test(focusedPrompt)) {
      this.emitDagTask(focusedPrompt, promptFileId);
      return;
    }

    if (HIGH_CHUNK_HINT_RE.test(focusedPrompt)) {
      this.emitHighChunks(focusedPrompt);
      return;
    }

    if (LATE_CHUNK_HINT_RE.test(focusedPrompt)) {
      this.emitLateChunk();
      return;
    }

    if (ERROR_SECRET_HINT_RE.test(focusedPrompt)) {
      this.emitErrorWithSecret();
      return;
    }

    if (STOP_VERIFY_HINT_RE.test(focusedPrompt)) {
      this.emitStopVerify();
      return;
    }

    if (NO_SANDBOX_HINT_RE.test(focusedPrompt)) {
      this.emitNoSandbox();
      return;
    }

    if (QUEUE_HINT_RE.test(focusedPrompt)) {
      this.emitQueueTest();
      return;
    }

    if (PLANNER_HINT_RE.test(focusedPrompt)) {
      this.emitPlannerPlan();
      return;
    }

    if (!trustMode || PERMISSION_HINT_RE.test(focusedPrompt)) {
      this.emitPermissionFlow(focusedPrompt, hostWorkDir);
      return;
    }

    const wantsToolEvents = TOOL_HINT_RE.test(focusedPrompt);
    const wantsSubagentEvents = SUBAGENT_HINT_RE.test(focusedPrompt);
    this.schedule(10, () => this.emit({ type: 'text', content: 'Mock agent received the request.\n' }));
    if (wantsToolEvents) {
      this.schedule(25, () => this.emit({ type: 'tool_use', toolName: 'Read', input: { file_path: 'README.md' } }));
      this.schedule(35, () => this.emit({ type: 'tool_result', content: 'Mock read result: README.md was inspected.' }));
    }
    if (wantsSubagentEvents) {
      this.schedule(45, () => this.emit({ type: 'subagent_start', agentType: 'ReviewAgent', description: 'Mock subagent review' }));
      this.schedule(60, () => this.emit({ type: 'subagent_result', agentType: 'ReviewAgent' }));
    }
    this.schedule(75, () => this.emit({ type: 'text', content: 'Mock agent completed successfully.\n' }));
    this.schedule(90, () => this.emit({ type: 'done', exitCode: 0 }));
  }

  write(input: string): void {
    if (this.killed || !this.pendingPermission) return;
    const allowed = input.trim().toLowerCase().startsWith('y');
    const pending = this.pendingPermission;
    this.pendingPermission = null;

    if (!allowed) {
      this.emit({ type: 'text', content: `Permission denied for ${pending.path}.\n` });
      this.emit({ type: 'done', exitCode: 1 });
      return;
    }

    try {
      if (pending.hostWorkDir) {
        writeSafeWorkspaceFile(pending.hostWorkDir, pending.path, pending.content);
      }
      this.emit({ type: 'tool_result', content: `Mock Write completed for ${pending.path}` });
      this.emit({ type: 'text', content: `Permission allowed; wrote ${pending.path}.\n` });
      this.emit({ type: 'done', exitCode: 0 });
    } catch (err: any) {
      this.emit({ type: 'error', message: err.message || 'Mock write failed' });
      this.emit({ type: 'done', exitCode: 1 });
    }
  }

  kill(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pendingPermission = null;
    this.emit({ type: 'text', content: 'Process stopped by user.\n' });
    this.emit({ type: 'done', exitCode: 0 });
    this.killed = true;
  }

  private reset(): void {
    this.killed = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pendingPermission = null;
  }

  private emit(event: ParsedEvent): void {
    if (this.killed) return;
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Keep mock event delivery isolated like real provider callbacks.
      }
    }
  }

  private schedule(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private emitPermissionFlow(prompt: string, hostWorkDir?: string): void {
    const filePath = extractFilePath(prompt) || 'mock-permission-output.txt';
    const content = `Mock provider wrote this file for: ${prompt.slice(0, 160)}\n`;
    this.pendingPermission = { hostWorkDir, path: filePath, content };
    this.schedule(10, () => this.emit({ type: 'text', content: 'Mock provider is preparing a file write.\n' }));
    this.schedule(20, () => this.emit({ type: 'tool_use', toolName: 'Write', input: { file_path: filePath, content } }));
    this.schedule(30, () => this.emit({ type: 'permission_request', tool: 'Write', path: filePath }));
  }

  private emitPlannerPlan(): void {
    const plan = {
      planTitle: 'Mock SmartSupport DAG',
      summary: 'Deterministic mock plan for AgentHub planner tests.',
      tasks: [
        {
          id: 'task-1',
          title: 'Implement chat API',
          description: 'mock-dag-success Create or update /api/chat for SmartSupport.',
          agentType: 'CodeAgent',
          dependsOn: [],
          expectedOutput: 'Working chat API',
          priority: 'high',
        },
        {
          id: 'task-2',
          title: 'Review chat behavior',
          description: 'mock-dag-success Review implementation and edge cases.',
          agentType: 'ReviewAgent',
          dependsOn: ['task-1'],
          expectedOutput: 'Review report',
          priority: 'medium',
        },
      ],
      missingAgents: [],
    };

    this.schedule(10, () => this.emit({ type: 'text', content: 'Mock planner generated a task DAG.\n```json\n' }));
    this.schedule(20, () => this.emit({ type: 'text', content: `${JSON.stringify(plan, null, 2)}\n` }));
    this.schedule(30, () => this.emit({ type: 'text', content: '```\n' }));
    this.schedule(40, () => this.emit({ type: 'done', exitCode: 0 }));
  }

  private emitDagTask(prompt: string, promptFileId?: string): void {
    const key = promptFileId || prompt.slice(0, 120);
    const attempts = (dagTaskAttempts.get(key) || 0) + 1;
    dagTaskAttempts.set(key, attempts);

    const title = extractPromptField(prompt, 'Task') || 'Untitled task';
    const description = extractPromptField(prompt, 'Description') || '';
    const delayMatch = prompt.match(DAG_DELAY_RE);
    const delayMs = delayMatch?.[1]
      ? Math.max(10, Math.min(Number.parseInt(delayMatch[1], 10), 2_000))
      : 40;
    const shouldFail =
      DAG_FAIL_RE.test(prompt) ||
      (DAG_FAIL_ONCE_RE.test(prompt) && attempts === 1);

    this.schedule(10, () => this.emit({
      type: 'text',
      content: `Mock DAG task executing: ${title}\nDescription: ${description}\n`,
    }));
    this.schedule(delayMs, () => {
      this.emit({
        type: 'text',
        content: shouldFail ? 'Mock DAG task failed deterministically.\n' : 'Mock DAG task completed successfully.\n',
      });
      this.emit({ type: 'done', exitCode: shouldFail ? 1 : 0 });
    });
  }

  private emitHighChunks(prompt: string): void {
      const match = prompt.match(HIGH_CHUNK_HINT_RE);
      const count = Math.min(Math.max(Number(match?.[1]) || 10, 1), 500);
      for (let i = 0; i < count; i++) {
        this.schedule(i * 3, () => this.emit({ type: 'text', content: `Chunk ${i + 1}/${count}: Mock streaming data block.\n` }));
      }
      this.schedule(count * 3 + 5, () => this.emit({ type: 'done', exitCode: 0 }));
    }

    private emitLateChunk(): void {
      this.schedule(10, () => this.emit({ type: 'text', content: 'Normal output before done.\n' }));
      this.schedule(20, () => this.emit({ type: 'done', exitCode: 0 }));
      this.schedule(50, () => this.emit({ type: 'text', content: 'LATE CHUNK AFTER DONE - SHOULD BE IGNORED.\n' }));
    }

    private emitErrorWithSecret(): void {
      globalRunningCount = Math.max(0, globalRunningCount - 1);
      this.schedule(5, () => this.emit({ type: 'error', message: 'Internal error: API_KEY=sk-live-mock-secret-12345, DATABASE_URL=postgresql://admin:secret@localhost/db, JWT_SECRET=super-secret-jwt-key' }));
      this.schedule(10, () => this.emit({ type: 'done', exitCode: 1 }));
    }

    private emitStopVerify(): void {
      this.schedule(10, () => this.emit({ type: 'text', content: 'Running long verification task.\n' }));
      const interval = setInterval(() => {
        if (this.killed) {
          clearInterval(interval);
          this.emit({ type: 'text', content: 'Process stopped by user.\n' });
          this.emit({ type: 'done', exitCode: 0 });
          return;
        }
        this.emit({ type: 'text', content: 'Still running...\n' });
      }, 200);
      this.timers.add(interval);
    }

    private emitNoSandbox(): void {
      this.schedule(5, () => this.emit({ type: 'error', message: 'No active sandbox for this session. Create a session first.' }));
      this.schedule(10, () => this.emit({ type: 'done', exitCode: 1 }));
    }

    private emitQueueTest(): void {
      globalRunningCount += 1;
      const currentCount = globalRunningCount;
      this.schedule(10, () => this.emit({ type: 'text', content: `Queue test: running count = ${currentCount}\n` }));
      this.schedule(50, () => {
        this.emit({ type: 'text', content: `Queue test: completed as #${currentCount}\n` });
        this.emit({ type: 'done', exitCode: 0 });
        globalRunningCount = Math.max(0, globalRunningCount - 1);
      });
    }

    isAlive(): boolean {
      return !this.killed;
    }

    static getGlobalRunningCount(): number {
      return globalRunningCount;
    }

    static resetGlobalRunningCount(): void {
      globalRunningCount = 0;
    }
  }

function extractUserRequest(prompt: string): string {
  const marker = 'User request:';
  const idx = prompt.lastIndexOf(marker);
  if (idx !== -1) return prompt.slice(idx + marker.length).trim();
  return prompt;
}

function extractFilePath(prompt: string): string | null {
  const match =
    prompt.match(/(?:file|path|文件|路径)\s*[:：=]\s*[`'"]?([^`'"\s，,]+)/i) ||
    prompt.match(/[`'"]([^`'"]+\.(?:md|txt|json|ts|tsx|js|jsx|css|html))[`'"]/i);
  if (!match?.[1]) return null;
  const normalized = normalize(match[1]).replace(/^(\.\.[/\\])+/, '');
  return normalized || null;
}

function extractPromptField(prompt: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = prompt.match(new RegExp(`^${escaped}:\\s*(.*)$`, 'im'));
  return match?.[1]?.trim() || null;
}

function writeSafeWorkspaceFile(hostWorkDir: string, filePath: string, content: string): void {
  const relativePath = isAbsolute(filePath) ? filePath.slice(1) : filePath;
  const target = resolve(hostWorkDir, relativePath);
  const rel = relative(hostWorkDir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Mock write path escapes workspace: ${filePath}`);
  }
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target, content, 'utf8');
}
