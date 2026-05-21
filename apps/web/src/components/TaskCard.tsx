import { TaskDAG } from './TaskDAG';
import type { TaskState } from '../store/appStore';

interface Props {
  planId: string;
  planTitle: string;
  summary: string;
  tasks: TaskState[];
  onConfirm?: () => void;
  onRetry?: (taskId: string) => void;
  onPause?: () => void;
}

export function TaskCard({ planId, planTitle, summary, tasks, onConfirm, onRetry, onPause }: Props) {
  const done = tasks.filter(t => t.status === 'done').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const waiting = tasks.filter(t => t.status === 'waiting').length;

  return (
    <div className="mx-4 my-3 bg-slate-800/90 border border-slate-700/60 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700/40 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">{planTitle}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{summary}</p>
        </div>
        <span className="text-xs text-slate-500 bg-slate-700/50 px-2 py-0.5 rounded-full">
          {done}/{tasks.length} done
          {running > 0 && ` · ${running} running`}
          {waiting > 0 && ` · ${waiting} waiting`}
          {failed > 0 && ` · ${failed} failed`}
        </span>
      </div>

      {/* DAG visualization */}
      <div className="p-2">
        <TaskDAG tasks={tasks} />
      </div>

      {/* Action buttons */}
      <div className="px-4 py-2 border-t border-slate-700/40 flex gap-2">
        {onConfirm && (
          <button onClick={onConfirm}
            className="px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs rounded-md font-medium transition">
            Confirm & Execute
          </button>
        )}
        {failed > 0 && onRetry && (
          tasks.filter(t => t.status === 'failed').map(t => (
            <button key={t.taskId} onClick={() => onRetry(t.taskId)}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs rounded-md font-medium transition">
              Retry {t.title}
            </button>
          ))
        )}
        {onPause && (
          <button onClick={onPause}
            className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white text-xs rounded-md font-medium transition">
            Pause Queue
          </button>
        )}
      </div>
    </div>
  );
}
