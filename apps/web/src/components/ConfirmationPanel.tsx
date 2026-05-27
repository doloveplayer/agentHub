import type { TaskNode } from '@agenthub/shared';
import { useState } from 'react';
import { Pencil, Check, X } from 'lucide-react';

interface Props {
  tasks: TaskNode[];
  onConfirm: () => void;
  onUpdateTask: (taskId: string, newDescription: string) => void;
  onUpdateField: (taskId: string, field: string, value: any) => void;
  onCancel: () => void;
}

const AGENT_TYPES = ['code-agent', 'review-agent', 'test-agent'] as const;
const AGENT_TYPE_LABELS: Record<string, string> = {
  'code-agent': 'CodeAgent',
  'review-agent': 'ReviewAgent',
  'test-agent': 'TestAgent',
};
const PRIORITIES = ['high', 'medium', 'low'];

export function ConfirmationPanel({ tasks, onConfirm, onUpdateTask, onUpdateField, onCancel }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editField, setEditField] = useState<string | null>(null);

  return (
    <div className="mx-4 my-2 bg-hub-surface border border-hub-warning/30 rounded-hub-lg px-4 py-3">
      <h3 className="text-sm font-semibold text-hub-warning mb-1">Review Task Plan</h3>
      <p className="text-xs text-hub-tertiary mb-3">
        {tasks.length} tasks planned. Click any field to edit, then confirm to execute.
      </p>
      <div className="space-y-2 mb-3 max-h-80 overflow-y-auto panel-scroll">
        {tasks.map((t) => (
          <div key={t.id} className="bg-hub-raised rounded-hub-md px-3 py-2">
            {/* Title + agentType + priority row */}
            <div className="flex items-center justify-between mb-1">
              {editingId === t.id && editField === 'title' ? (
                <InlineEdit
                  value={t.title}
                  onSave={(v) => { onUpdateField(t.id, 'title', v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                />
              ) : (
                <span
                  className="text-xs font-medium text-hub-primary cursor-pointer hover:text-hub-link"
                  onClick={() => { setEditingId(t.id); setEditField('title'); }}
                >{t.title}</span>
              )}
              <div className="flex items-center gap-1.5 shrink-0">
                {editingId === t.id && editField === 'agentType' ? (
                  <select
                    value={t.agentType}
                    onChange={(e) => { onUpdateField(t.id, 'agentType', e.target.value); setEditingId(null); setEditField(null); }}
                    className="text-[10px] bg-hub-input text-hub-secondary rounded px-1 py-0.5 border border-hub"
                  >
                    {AGENT_TYPES.map((at) => <option key={at} value={at}>{AGENT_TYPE_LABELS[at] || at}</option>)}
                  </select>
                ) : (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded bg-hub-hover text-hub-tertiary cursor-pointer hover:bg-hub-border"
                    onClick={() => { setEditingId(t.id); setEditField('agentType'); }}
                  >{t.agentType}</span>
                )}
                {editingId === t.id && editField === 'priority' ? (
                  <select
                    value={t.priority}
                    onChange={(e) => { onUpdateField(t.id, 'priority', e.target.value); setEditingId(null); setEditField(null); }}
                    className="text-[10px] bg-hub-input text-hub-secondary rounded px-1 py-0.5 border border-hub"
                  >
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <span
                    className={`text-[10px] px-1 py-0.5 rounded cursor-pointer hover:opacity-80 ${
                      t.priority === 'high' ? 'bg-hub-danger/15 text-hub-danger' :
                      t.priority === 'low' ? 'bg-hub-hover text-hub-tertiary' :
                      'bg-hub-info/15 text-hub-info'
                    }`}
                    onClick={() => { setEditingId(t.id); setEditField('priority'); }}
                  >{t.priority}</span>
                )}
              </div>
            </div>

            {/* Description */}
            <div className="mt-1">
              {editingId === t.id && editField === 'description' ? (
                <InlineEdit
                  value={t.description}
                  multiline
                  onSave={(v) => { onUpdateTask(t.id, v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                />
              ) : (
                <p
                  className="text-xs text-hub-tertiary cursor-pointer hover:text-hub-secondary truncate"
                  onClick={() => { setEditingId(t.id); setEditField('description'); }}
                >{t.description || 'No description'}</p>
              )}
            </div>

            {/* DependsOn */}
            <div className="mt-1">
              {editingId === t.id && editField === 'dependsOn' ? (
                <InlineEdit
                  value={t.dependsOn.join(', ')}
                  onSave={(v) => { onUpdateField(t.id, 'dependsOn', v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                  placeholder="task-1, task-2"
                />
              ) : (
                t.dependsOn.length > 0 ? (
                  <p
                    className="text-[10px] text-hub-muted cursor-pointer hover:text-hub-tertiary"
                    onClick={() => { setEditingId(t.id); setEditField('dependsOn'); }}
                  >Depends on: {t.dependsOn.join(', ')}</p>
                ) : (
                  <p
                    className="text-[10px] text-hub-muted/50 cursor-pointer hover:text-hub-tertiary"
                    onClick={() => { setEditingId(t.id); setEditField('dependsOn'); }}
                  >No dependencies (click to add)</p>
                )
              )}
            </div>

            {/* ExpectedOutput */}
            <div className="mt-1">
              {editingId === t.id && editField === 'expectedOutput' ? (
                <InlineEdit
                  value={t.expectedOutput || ''}
                  onSave={(v) => { onUpdateField(t.id, 'expectedOutput', v); setEditingId(null); setEditField(null); }}
                  onCancel={() => { setEditingId(null); setEditField(null); }}
                  placeholder="Expected output file or result"
                />
              ) : (
                <p
                  className="text-[10px] text-hub-muted/70 cursor-pointer hover:text-hub-tertiary truncate"
                  onClick={() => { setEditingId(t.id); setEditField('expectedOutput'); }}
                >Output: {t.expectedOutput || 'Unspecified'}</p>
              )}
            </div>
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

function InlineEdit({
  value, onSave, onCancel, multiline, placeholder,
}: {
  value: string; onSave: (v: string) => void; onCancel: () => void;
  multiline?: boolean; placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const inputClass = "bg-hub-input text-xs text-hub-secondary rounded p-1 border border-hub w-full";

  return (
    <div className="flex flex-col gap-1">
      {multiline ? (
        <textarea value={text} onChange={(e) => setText(e.target.value)}
          className={inputClass + " resize-none"} rows={2} placeholder={placeholder} />
      ) : (
        <input value={text} onChange={(e) => setText(e.target.value)}
          className={inputClass} placeholder={placeholder} />
      )}
      <div className="flex gap-2">
        <button onClick={() => onSave(text)} className="text-xs text-hub-success"><Check className="w-3 h-3 inline" /></button>
        <button onClick={onCancel} className="text-xs text-hub-tertiary"><X className="w-3 h-3 inline" /></button>
      </div>
    </div>
  );
}
