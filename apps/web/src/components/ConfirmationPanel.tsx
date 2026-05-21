import type { TaskNode } from '@agenthub/shared';
import { useState } from 'react';

interface Props {
  tasks: TaskNode[];
  onConfirm: () => void;
  onUpdateTask: (taskId: string, newDescription: string) => void;
  onCancel: () => void;
}

export function ConfirmationPanel({ tasks, onConfirm, onUpdateTask, onCancel }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  return (
    <div className="mx-4 my-2 bg-slate-800/90 border border-amber-700/50 rounded-xl px-4 py-3">
      <h3 className="text-sm font-semibold text-amber-300 mb-1">Review Task Plan</h3>
      <p className="text-xs text-slate-500 mb-3">
        {tasks.length} tasks planned. Review, modify if needed, then confirm to execute.
      </p>
      <div className="space-y-2 mb-3 max-h-64 overflow-y-auto panel-scroll">
        {tasks.map((t) => (
          <div key={t.id} className="bg-slate-700/30 rounded-lg px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-200">{t.title}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-600 text-slate-400">
                  {t.agentType}
                </span>
                {t.priority !== 'medium' && (
                  <span className={`text-[10px] px-1 py-0.5 rounded ${
                    t.priority === 'high' ? 'bg-red-900/40 text-red-300' : 'bg-slate-600 text-slate-400'
                  }`}>{t.priority}</span>
                )}
              </div>
            </div>
            {editingId === t.id ? (
              <div className="mt-1">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full bg-slate-900 text-xs text-slate-300 rounded p-1.5 border border-slate-600 resize-none"
                  rows={2}
                />
                <div className="flex gap-2 mt-1">
                  <button onClick={() => {
                    onUpdateTask(t.id, editText);
                    setEditingId(null);
                  }} className="text-xs text-green-400 hover:text-green-300">Save</button>
                  <button onClick={() => setEditingId(null)}
                    className="text-xs text-slate-500 hover:text-slate-400">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-slate-500 flex-1 truncate">{t.description}</p>
                <button onClick={() => { setEditingId(t.id); setEditText(t.description); }}
                  className="text-xs text-blue-400 hover:text-blue-300 shrink-0">Edit</button>
              </div>
            )}
            {t.dependsOn.length > 0 && (
              <p className="text-[10px] text-slate-600 mt-1">
                Depends on: {t.dependsOn.join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={onConfirm}
          className="px-4 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs rounded-md font-medium transition">
          Confirm All
        </button>
        <button onClick={onCancel}
          className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-md transition">
          Cancel
        </button>
      </div>
    </div>
  );
}
