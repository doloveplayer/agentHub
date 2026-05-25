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
    <div className="mx-4 my-2 bg-hub-surface border border-hub-warning/30 rounded-hub-lg px-4 py-3">
      <h3 className="text-sm font-semibold text-hub-warning mb-1">Review Task Plan</h3>
      <p className="text-xs text-hub-tertiary mb-3">
        {tasks.length} tasks planned. Review, modify if needed, then confirm to execute.
      </p>
      <div className="space-y-2 mb-3 max-h-64 overflow-y-auto panel-scroll">
        {tasks.map((t) => (
          <div key={t.id} className="bg-hub-raised rounded-hub-md px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-hub-primary">{t.title}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-hub-hover text-hub-tertiary">
                  {t.agentType}
                </span>
                {t.priority !== 'medium' && (
                  <span className={`text-[10px] px-1 py-0.5 rounded ${
                    t.priority === 'high' ? 'bg-hub-danger/15 text-hub-danger' : 'bg-hub-hover text-hub-tertiary'
                  }`}>{t.priority}</span>
                )}
              </div>
            </div>
            {editingId === t.id ? (
              <div className="mt-1">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full bg-hub-input text-xs text-hub-secondary rounded p-1.5 border border-hub resize-none"
                  rows={2}
                />
                <div className="flex gap-2 mt-1">
                  <button onClick={() => {
                    onUpdateTask(t.id, editText);
                    setEditingId(null);
                  }} className="text-xs text-hub-success hover:text-hub-success/80">Save</button>
                  <button onClick={() => setEditingId(null)}
                    className="text-xs text-hub-tertiary hover:text-hub-secondary">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-hub-tertiary flex-1 truncate">{t.description}</p>
                <button onClick={() => { setEditingId(t.id); setEditText(t.description); }}
                  className="text-xs text-hub-link hover:underline shrink-0">Edit</button>
              </div>
            )}
            {t.dependsOn.length > 0 && (
              <p className="text-[10px] text-hub-muted mt-1">
                Depends on: {t.dependsOn.join(', ')}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={onConfirm}
          className="px-4 py-1.5 bg-hub-success hover:bg-hub-success/80 text-white text-xs rounded-md font-medium transition">
          Confirm All
        </button>
        <button onClick={onCancel}
          className="px-4 py-1.5 bg-hub-hover hover:bg-hub-border text-hub-secondary text-xs rounded-md transition">
          Cancel
        </button>
      </div>
    </div>
  );
}
