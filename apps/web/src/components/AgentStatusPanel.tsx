import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { AgentCard } from './AgentCard';
import { TaskCard } from './TaskCard';
import { FileTree } from './FileTree';
import { VersionTimeline } from './VersionTimeline';
import { FullscreenDiffViewer } from './FullscreenDiffViewer';
import { PreviewFrame } from './PreviewFrame';
import { WorkspaceFileEditor } from './WorkspaceFileEditor';
import { api } from '../lib/api';
import { workspaceDownloadName } from '../lib/workspaceFile';
import type { AgentConfig, Message } from '@agenthub/shared';
import type { AgentEvent, TaskState } from '../store/appStore';

const EMPTY_ARR: Message[] = [];
const EMPTY_TASK_PLANS: Record<string, TaskState[]> = {};
type PlanSummary = { total: number; completed: number; failed: number; fileChanges: string[]; timestamp: number };
const EMPTY_PLAN_SUMMARIES: Record<string, PlanSummary> = {};

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
  const [fullscreenDiff, setFullscreenDiff] = useState<{ from: string; to: string } | null>(null);
  const [htmlPreviewSrc, setHtmlPreviewSrc] = useState<string | null>(null);
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

  // Sort by status; same status keeps original order (Planner first)
  const sortedAgents = [...agentStates].sort((a, b) => {
    const order = { running: 0, queued: 1, done: 2, idle: 3 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  const runningCount = sortedAgents.filter(a => a.status === 'running').length;
  const queuedCount = sortedAgents.filter(a => a.status === 'queued').length;
  const idleCount = sortedAgents.filter(a => a.status === 'idle').length;
  const doneCount = sortedAgents.filter(a => a.status === 'done').length;

  // ---- Aggregated stats (session-scoped) ----
  const taskPlans = useAppStore((s) => activeSessionId ? (s.taskPlans[activeSessionId] ?? EMPTY_TASK_PLANS) : EMPTY_TASK_PLANS);
  const planSummaries = useAppStore((s) => activeSessionId ? (s.planSummaries[activeSessionId] ?? EMPTY_PLAN_SUMMARIES) : EMPTY_PLAN_SUMMARIES);
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

  // Collect file changes from plan summaries (already session-scoped above)
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
    <div className="w-full border-l border-hub flex flex-col h-full bg-hub-root">
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
      {activeTab === 'Preview' && activeSessionId ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {htmlPreviewSrc ? (
            <iframe srcDoc={htmlPreviewSrc} className="flex-1 w-full border-0 bg-white" sandbox="allow-scripts allow-forms allow-same-origin" />
          ) : (
            <PreviewFrame sessionId={activeSessionId} onSelection={onPreviewSelection} />
          )}
        </div>
      ) : (
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
              <>
                {/\.html?$/i.test(selectedFilePath) && (
                  <div className="flex gap-2 px-3">
                    <button
                      onClick={async () => {
                        try {
                          const result = await api.downloadWorkspacePath(activeSessionId!, selectedFilePath, 'utf-8') as any;
                          const text = typeof result === 'string' ? result : (result.blob ? await (result.blob as Blob).text() : String(result));
                          setHtmlPreviewSrc(text);
                          setActiveTab('Preview');
                        } catch { addToast('Failed to load preview', 'error'); }
                      }}
                      className="px-3 py-1.5 text-xs bg-hub-accent text-white rounded-md hover:bg-hub-accent-hover transition"
                    >
                      🔍 Preview
                    </button>
                  </div>
                )}
                <WorkspaceFileEditor
                  sessionId={activeSessionId}
                  path={selectedFilePath}
                  onClose={() => setSelectedFilePath(null)}
                  onToggleFullscreen={() => setFullscreenFilePath(selectedFilePath)}
                  onDownloadOriginal={(path) => downloadWorkspacePath(path, 'file')}
                />
              </>
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
            {fullscreenDiff && activeSessionId && (
              <>
                <div className="fixed inset-0 z-40 bg-black/70" onClick={() => setFullscreenDiff(null)} />
                <div className="fixed left-1/2 top-1/2 z-50 h-[calc(100vh-48px)] w-[min(1180px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 shadow-2xl flex flex-col overflow-hidden rounded-md border border-hub bg-hub-surface">
                  <FullscreenDiffViewer
                    sessionId={activeSessionId}
                    from={fullscreenDiff.from}
                    to={fullscreenDiff.to}
                    onClose={() => setFullscreenDiff(null)}
                  />
                </div>
              </>
            )}
            <VersionTimeline sessionId={activeSessionId} onCompare={(from, to) => setFullscreenDiff({ from, to })} />
          </div>
        )}
        {activeTab === 'Tasks' && (
          <ActivePlanView onReplanTask={onReplanTask} onForceComplete={onForceComplete} onForceFail={onForceFail} />
        )}
      </div>
      )}
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
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const taskPlans = useAppStore((s) => activeSessionId ? (s.taskPlans[activeSessionId] ?? EMPTY_TASK_PLANS) : EMPTY_TASK_PLANS);
  const planSummaries = useAppStore((s) => activeSessionId ? (s.planSummaries[activeSessionId] ?? EMPTY_PLAN_SUMMARIES) : EMPTY_PLAN_SUMMARIES);
  const removeTaskPlan = useAppStore((s) => s.removeTaskPlan);
  const [showHistory, setShowHistory] = useState(false);
  const [historyPlans, setHistoryPlans] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const handleArchive = async (planId: string) => {
    if (!activeSessionId) return;
    removeTaskPlan(activeSessionId, planId);
    try { await api.archivePlan(activeSessionId, planId); } catch (e) { console.warn('[archive] failed:', e); }
  };

  const loadHistory = async () => {
    if (!activeSessionId) return;
    setHistoryLoading(true);
    try {
      const res = await api.getPlanHistory(activeSessionId);
      setHistoryPlans(res.plans ?? []);
    } catch (e) { console.warn('[history] failed:', e); }
    finally { setHistoryLoading(false); }
  };

  const toggleHistory = () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && historyPlans.length === 0) loadHistory();
  };

  const plans = Object.entries(taskPlans);
  const hasContent = plans.length > 0 || Object.keys(planSummaries).length > 0;

  if (!hasContent && !showHistory) {
    return (
      <div className="text-center py-4 space-y-2">
        <p className="text-footnote text-white/25">No active task plans</p>
        <button onClick={toggleHistory}
          className="text-xs text-hub-accent hover:text-hub-accent/80 underline underline-offset-2">
          查看历史任务
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Toggle button */}
      <div className="flex justify-end px-2">
        <button onClick={toggleHistory}
          className={`text-xs px-2 py-1 rounded transition ${showHistory ? 'bg-hub-accent/20 text-hub-accent' : 'text-hub-muted hover:text-hub-accent hover:bg-hub-accent/10'}`}>
          {showHistory ? '当前任务' : '全部历史'}
        </button>
      </div>

      {showHistory ? (
        /* History view */
        <div className="space-y-2">
          {historyLoading ? (
            <p className="text-footnote text-white/25 text-center py-4">加载中...</p>
          ) : historyPlans.length === 0 ? (
            <p className="text-footnote text-white/25 text-center py-4">暂无历史任务</p>
          ) : (
            historyPlans.map((plan: any) => (
              <div key={plan.planId}>
                <TaskCard planId={plan.planId}
                  planTitle={plan.planTitle || 'Plan'}
                  summary={`${plan.tasks?.length ?? 0} tasks · ${plan.status}`}
                  tasks={(plan.tasks ?? []).map((t: any) => ({ ...t, taskId: t.id }))}
                  onArchive={(pid: string) => {
                    handleArchive(pid);
                    setHistoryPlans(prev => prev.filter(p => p.planId !== pid));
                  }} />
              </div>
            ))
          )}
        </div>
      ) : (
        /* Active plans view */
        <>
          {plans.map(([planId, tasks]) => (
            <div key={planId}>
              <TaskCard planId={planId}
                planTitle="Active Plan" summary={`${tasks.length} tasks`} tasks={tasks}
                onReplan={onReplanTask ? (taskId: string) => onReplanTask(planId, taskId) : undefined}
                onForceComplete={onForceComplete ? (taskId: string) => onForceComplete(planId, taskId) : undefined}
                onForceFail={onForceFail ? (taskId: string) => onForceFail(planId, taskId) : undefined}
                onArchive={handleArchive} />
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
        </>
      )}
    </div>
  );
}
