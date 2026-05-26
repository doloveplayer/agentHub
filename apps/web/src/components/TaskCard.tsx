import { TaskDAG } from './TaskDAG';
import type { TaskState } from '../store/appStore';

interface Props {
  planId: string;
  planTitle: string;
  summary: string;
  tasks: TaskState[];
  onConfirm?: () => void;
  onRetry?: (taskId: string) => void;
  onReplan?: (taskId: string) => void;
  onPause?: () => void;
}

export function TaskCard({ planId, planTitle, summary, tasks, onConfirm, onRetry, onReplan, onPause }: Props) {
  const done = tasks.filter(t => t.status === 'done').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const waiting = tasks.filter(t => t.status === 'waiting').length;

  return (
    <div className="mx-4 my-3 bg-hub-surface border border-hub rounded-hub-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-hub flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-hub-primary">{planTitle}</h3>
          <p className="text-xs text-hub-tertiary mt-0.5">{summary}</p>
        </div>
        <span className="text-xs text-hub-tertiary bg-hub-raised px-2 py-0.5 rounded-full">
          {done}/{tasks.length} done
          {running > 0 && ` · ${running} running`}
          {waiting > 0 && ` · ${waiting} waiting`}
          {failed > 0 && ` · ${failed} failed`}
        </span>
      </div>

      {/* DAG visualization */}
      <div className="p-2">
        <TaskDAG tasks={tasks} onReplanTask={onReplan} />
      </div>

      {/* Action buttons */}
      <div className="px-4 py-2 border-t border-hub flex gap-2 flex-wrap">
        {onConfirm && (
          <button onClick={onConfirm}
            className="px-3 py-1.5 bg-hub-success hover:bg-hub-success/80 text-white text-xs rounded-md font-medium transition">
            Confirm & Execute
          </button>
        )}
        {failed > 0 && onRetry && (
          tasks.filter(t => t.status === 'failed').map(t => (
            <button key={t.taskId} onClick={() => onRetry(t.taskId)}
              className="px-3 py-1.5 bg-hub-danger hover:bg-hub-danger/80 text-white text-xs rounded-md font-medium transition">
              Retry {t.title}
            </button>
          ))
        )}
        {failed > 0 && onReplan && (
          tasks.filter(t => t.status === 'failed').map(t => (
            <button key={'replan-' + t.taskId} onClick={() => onReplan(t.taskId)}
              className="px-3 py-1.5 bg-hub-accent hover:bg-hub-accent/80 text-white text-xs rounded-md font-medium transition">
              让 Main Agent 重新规划 {t.title}
            </button>
          ))
        )}
        {onPause && (
          <button onClick={onPause}
            className="px-3 py-1.5 bg-hub-warning hover:bg-hub-warning/80 text-white text-xs rounded-md font-medium transition">
            Pause Queue
          </button>
        )}
      </div>
    </div>
  );
}
