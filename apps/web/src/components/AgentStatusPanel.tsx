import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import { TaskCard } from './TaskCard';
import { FileTree } from './FileTree';
import { VersionTimeline } from './VersionTimeline';
import { PreviewFrame } from './PreviewFrame';
import { WorkspaceFileEditor } from './WorkspaceFileEditor';
import { api } from '../lib/api';
import { workspaceDownloadName } from '../lib/workspaceFile';
import type { AgentConfig, Message } from '@agenthub/shared';
import type { AgentEvent } from '../store/appStore';

const EMPTY_ARR: Message[] = [];

interface Props {
  sessionAgents: AgentConfig[];
  onStopAgent?: (agentMessageId: string) => void;
  onReplanTask?: (planId: string, taskId: string) => void;
  onPreviewSelection?: (selection: { text: string; rect: { top: number; left: number; width: number; height: number }; url: string } | null) => void;
  onForceComplete?: (planId: string, taskId: string) => void;
  onForceFail?: (planId: string, taskId: string) => void;
  onConfigureAgent?: (agentId: string) => void;
}

type PanelTab = 'Files' | 'Agents' | 'Tasks' | 'Preview';
type ViewMode = 'detailed' | 'aggregated';

export function AgentStatusPanel({ sessionAgents, onStopAgent, onReplanTask, onPreviewSelection, onForceComplete, onForceFail, onConfigureAgent }: Props) {
  const [activeTab, setActiveTab] = useState<PanelTab>('Agents');
  const [viewMode, setViewMode] = useState<ViewMode>('detailed');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fullscreenFilePath, setFullscreenFilePath] = useState<string | null>(null);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const addToast = useAppStore((s) => s.addToast);
  const agentEvents = useAppStore((s) => s.agentEvents);
  const messages = useAppStore((s) => {
    const sessionId = s.activeSessionId;
    return sessionId ? (s.messages[sessionId] ?? EMPTY_ARR) : EMPTY_ARR;
  });

  const agentStates = sessionAgents.map((agent) => {
    const agentMsgs = messages.filter((m) => m.agentId === agent.id);
    const running = agentMsgs.some((m) => m.status === 'streaming');
    const queued = agentMsgs.some((m) => m.status === 'queued');
    const done = agentMsgs.length > 0 && agentMsgs.every((m) => m.status === 'done');

    let status: 'running' | 'queued' | 'done' | 'idle' = 'idle';
    if (running) status = 'running';
    else if (queued) status = 'queued';
    else if (done) status = 'done';

    const events: AgentEvent[] = [];
    for (const msg of agentMsgs) {
      const evs = agentEvents[msg.id];
      if (evs) events.push(...evs);
    }

    return { agent, status, events };
  });

  // Sort: running → queued → done → idle
  const sortedAgents = [...agentStates].sort((a, b) => {
    const order = { running: 0, queued: 1, done: 2, idle: 3 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  const runningCount = sortedAgents.filter(a => a.status === 'running').length;
  const queuedCount = sortedAgents.filter(a => a.status === 'queued').length;
  const idleCount = sortedAgents.filter(a => a.status === 'idle').length;
  const doneCount = sortedAgents.filter(a => a.status === 'done').length;

  // ---- Aggregated stats ----
  const taskPlans = useAppStore((s) => s.taskPlans);
  const planSummaries = useAppStore((s) => s.planSummaries);
  const allPlans = Object.entries(taskPlans);

  // Token totals from all agent messages
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
  for (const msg of messages) {
    totalInput += msg.inputTokens ?? 0;
    totalOutput += msg.outputTokens ?? 0;
    totalCacheRead += msg.cacheReadTokens ?? 0;
    totalCacheCreate += msg.cacheCreateTokens ?? 0;
  }

  // Task stats across all plans
  let totalTasks = 0, tasksDone = 0, tasksFailed = 0;
  for (const [, tasks] of allPlans) {
    totalTasks += tasks.length;
    tasksDone += tasks.filter(t => t.status === 'done').length;
    tasksFailed += tasks.filter(t => t.status === 'failed').length;
  }
  // Also merge from planSummaries
  for (const s of Object.values(planSummaries)) {
    // planSummaries are authoritative for archived plans already removed from taskPlans
  }

  // Tool & file stats from agent events
  const allEvents = Object.values(agentEvents).flat();
  const toolUseCount = allEvents.filter(e => e.type === 'tool_use').length;
  const fileCount = allEvents.filter(e => e.type === 'file_produced').length;

  // Collect file changes from plan summaries
  const allFileChanges = new Set<string>();
  for (const s of Object.values(planSummaries)) {
    for (const f of s.fileChanges) allFileChanges.add(f);
  }

  const tabs: PanelTab[] = ['Files', 'Agents', 'Tasks', 'Preview'];
  const modes: { key: ViewMode; label: string }[] = [
    { key: 'detailed', label: '详细' },
    { key: 'aggregated', label: '聚合' },
  ];

  const downloadWorkspacePath = async (path: string, type: 'file' | 'directory') => {
    if (!activeSessionId) return;
    try {
      const result = await api.downloadWorkspacePath(activeSessionId, path);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename || workspaceDownloadName(path, type);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      addToast(err?.message || 'Download failed', 'error');
    }
  };

  return (
    <div className="w-full border-l border-hub flex flex-col h-full">
      <div className="flex border-b border-hub">
        {tabs.map((tab) => (
          <div
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-center py-2.5 text-footnote cursor-pointer border-b-2 font-medium select-none ${
              activeTab === tab
                ? 'text-hub-primary border-b-2 border-hub-accent'
                : 'text-hub-muted border-transparent hover:text-hub-secondary hover:bg-hub-hover'
            }`}
          >
            {tab}
          </div>
        ))}
      </div>
      {activeTab === 'Agents' && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-hub bg-hub-surface">
          <div className="flex gap-0.5 mr-auto">
            {modes.map((m) => (
              <button
                key={m.key}
                onClick={() => setViewMode(m.key)}
                className={`px-2 py-0.5 text-[10px] rounded font-medium transition ${
                  viewMode === m.key
                    ? 'bg-hub-accent/20 text-hub-accent'
                    : 'text-hub-muted hover:text-hub-secondary'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {viewMode === 'detailed' && (
            <span className="text-[10px] text-hub-muted ml-auto flex-shrink-0">
              {runningCount}/{sortedAgents.length} 运行 · {idleCount} 空闲
            </span>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto panel-scroll p-3">
        {activeTab === 'Agents' && viewMode === 'aggregated' && (
          <AggregatedSummary
            agents={sortedAgents.length}
            running={runningCount}
            queued={queuedCount}
            idle={idleCount}
            done={doneCount}
            totalInput={totalInput}
            totalOutput={totalOutput}
            totalCacheRead={totalCacheRead}
            totalCacheCreate={totalCacheCreate}
            totalTasks={totalTasks}
            tasksDone={tasksDone}
            tasksFailed={tasksFailed}
            toolUseCount={toolUseCount}
            fileCount={fileCount}
            fileChanges={[...allFileChanges]}
          />
        )}
        {activeTab === 'Agents' && viewMode === 'detailed' && (
          <>
            {sortedAgents.length === 0 && (
              <p className="text-footnote text-hub-muted text-center py-4">No agents in this session</p>
            )}
            {sortedAgents.map(({ agent, status, events }) => {
              const runningMsg = messages.find((m) => m.agentId === agent.id && m.status === 'streaming');
              return (
              <AgentCard
                key={agent.id}
                agentId={agent.id}
                displayName={agent.displayName}
                agentName={agent.name}
                status={status}
                events={events}
                onStop={runningMsg && onStopAgent ? () => onStopAgent(runningMsg.id) : undefined}
                provider={agent.provider}
                messages={messages}
                onConfigure={onConfigureAgent ? () => onConfigureAgent(agent.id) : undefined}
              />
              );
            })}
          </>
        )}
        {activeTab === 'Files' && activeSessionId && (
          <div className="space-y-4">
            <FileTree
              sessionId={activeSessionId}
              onSelectFile={setSelectedFilePath}
              onOpenFile={(path) => {
                setSelectedFilePath(path);
                setFullscreenFilePath(path);
              }}
              onDownloadPath={downloadWorkspacePath}
            />
            {selectedFilePath && (
              <WorkspaceFileEditor
                sessionId={activeSessionId}
                path={selectedFilePath}
                onClose={() => setSelectedFilePath(null)}
                onToggleFullscreen={() => setFullscreenFilePath(selectedFilePath)}
                onDownloadOriginal={(path) => downloadWorkspacePath(path, 'file')}
              />
            )}
            {fullscreenFilePath && (
              <WorkspaceFileEditor
                sessionId={activeSessionId}
                path={fullscreenFilePath}
                fullscreen
                onClose={() => setFullscreenFilePath(null)}
                onToggleFullscreen={() => setFullscreenFilePath(null)}
                onDownloadOriginal={(path) => downloadWorkspacePath(path, 'file')}
              />
            )}
            <VersionTimeline sessionId={activeSessionId} />
          </div>
        )}
        {activeTab === 'Tasks' && (
          <ActivePlanView onReplanTask={onReplanTask} onForceComplete={onForceComplete} onForceFail={onForceFail} />
        )}
        {activeTab === 'Preview' && activeSessionId && (
          <PreviewFrame sessionId={activeSessionId} onSelection={onPreviewSelection} />
        )}
      </div>
    </div>
  );
}

/** Session-level summary dashboard shown in aggregated view mode. */
function AggregatedSummary({
  agents, running, queued, idle, done,
  totalInput, totalOutput, totalCacheRead, totalCacheCreate,
  totalTasks, tasksDone, tasksFailed,
  toolUseCount, fileCount, fileChanges,
}: {
  agents: number; running: number; queued: number; idle: number; done: number;
  totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheCreate: number;
  totalTasks: number; tasksDone: number; tasksFailed: number;
  toolUseCount: number; fileCount: number; fileChanges: string[];
}) {
  const totalCache = totalCacheRead + totalCacheCreate;
  const totalTokens = totalInput + totalOutput;

  return (
    <div className="space-y-3 p-3">
      {/* Agent status bar */}
      <div className="bg-hub-surface rounded-xl p-3 border border-hub">
        <h4 className="text-[10px] font-semibold text-hub-muted uppercase tracking-wide mb-2">Agents</h4>
        <div className="flex gap-2 text-xs">
          <StatBadge label="总数" value={agents} />
          <StatBadge label="运行" value={running} color="text-hub-accent" />
          <StatBadge label="排队" value={queued} color="text-hub-warning" />
          <StatBadge label="完成" value={done} color="text-hub-success" />
          <StatBadge label="空闲" value={idle} color="text-hub-muted" />
        </div>
      </div>

      {/* Token usage */}
      <div className="bg-hub-surface rounded-xl p-3 border border-hub">
        <h4 className="text-[10px] font-semibold text-hub-muted uppercase tracking-wide mb-2">Token 用量</h4>
        <div className="flex gap-2 flex-wrap text-xs">
          <StatBadge label="总计" value={formatShortNum(totalTokens)} />
          <StatBadge label="输入" value={formatShortNum(totalInput)} color="text-blue-400" />
          <StatBadge label="输出" value={formatShortNum(totalOutput)} color="text-green-400" />
          <StatBadge label="缓存" value={formatShortNum(totalCache)} color="text-purple-400" />
        </div>
      </div>

      {/* Tasks */}
      <div className="bg-hub-surface rounded-xl p-3 border border-hub">
        <h4 className="text-[10px] font-semibold text-hub-muted uppercase tracking-wide mb-2">任务</h4>
        <div className="flex gap-2 text-xs">
          <StatBadge label="总计" value={totalTasks} />
          <StatBadge label="完成" value={tasksDone} color="text-hub-success" />
          <StatBadge label="失败" value={tasksFailed} color="text-hub-danger" />
        </div>
      </div>

      {/* Tool & File stats */}
      <div className="bg-hub-surface rounded-xl p-3 border border-hub">
        <h4 className="text-[10px] font-semibold text-hub-muted uppercase tracking-wide mb-2">工具 & 文件</h4>
        <div className="flex gap-2 flex-wrap text-xs">
          <StatBadge label="工具调用" value={toolUseCount} color="text-hub-accent" />
          <StatBadge label="产出文件" value={fileCount} color="text-hub-success" />
        </div>
        {fileChanges.length > 0 && (
          <div className="mt-2 text-[10px] text-hub-muted">
            <span className="font-medium">修改文件: </span>
            {fileChanges.map(f => (
              <span key={f} className="inline-block mr-2 mb-1 px-1.5 py-0.5 bg-hub-hover rounded">{f}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md bg-hub-raised`}>
      <span className="text-hub-muted text-[10px]">{label}</span>
      <span className={`font-semibold text-xs ${color || 'text-hub-primary'}`}>{value}</span>
    </span>
  );
}

function formatShortNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
/** Shows the active task plan from the store in the Tasks tab */
function ActivePlanView({ onReplanTask, onForceComplete, onForceFail }: {
  onReplanTask?: (planId: string, taskId: string) => void;
  onForceComplete?: (planId: string, taskId: string) => void;
  onForceFail?: (planId: string, taskId: string) => void;
}) {
  const taskPlans = useAppStore((s) => s.taskPlans);
  const planSummaries = useAppStore((s) => s.planSummaries);
  const removeTaskPlan = useAppStore((s) => s.removeTaskPlan);
  const plans = Object.entries(taskPlans);
  if (plans.length === 0 && Object.keys(planSummaries).length === 0) {
    return <p className="text-footnote text-white/25 text-center py-4">No active task plans</p>;
  }
  return (
    <div className="space-y-2">
      {plans.map(([planId, tasks]) => (
        <div key={planId}>
          <TaskCard planId={planId}
            planTitle="Active Plan" summary={`${tasks.length} tasks`} tasks={tasks}
            onReplan={onReplanTask ? (taskId: string) => onReplanTask(planId, taskId) : undefined}
            onForceComplete={onForceComplete ? (taskId: string) => onForceComplete(planId, taskId) : undefined}
            onForceFail={onForceFail ? (taskId: string) => onForceFail(planId, taskId) : undefined}
            onDismiss={removeTaskPlan} />
          {planSummaries[planId] && (
            <div className="mt-1 px-3 py-2 rounded-md bg-hub-surface text-caption">
              <div className="text-hub-secondary font-medium mb-1">Plan Summary</div>
              <div className="flex gap-3 text-hub-tertiary">
                <span className="text-hub-success">{planSummaries[planId].completed} done</span>
                {planSummaries[planId].failed > 0 && <span className="text-hub-danger">{planSummaries[planId].failed} failed</span>}
                <span>{planSummaries[planId].total - planSummaries[planId].completed - planSummaries[planId].failed} remaining</span>
              </div>
              {planSummaries[planId].fileChanges.length > 0 && (
                <div className="mt-1 text-hub-muted truncate">
                  Files: {planSummaries[planId].fileChanges.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
