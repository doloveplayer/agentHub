import { useState, useEffect, useRef } from 'react';
import { X, Save, RotateCcw, Plus, Pencil, Trash2, Upload, AlertTriangle, Package } from 'lucide-react';
import { api } from '../lib/api';
import { useAppStore } from '../store/appStore';
import type { SkillDef } from '@agenthub/shared';

interface Props {
  agentId: string;
  onClose: () => void;
  onSaved?: () => void;
}

interface EditableSkill {
  name: string;
  description: string;
  content: string;
  _editing?: boolean;
  _isNew?: boolean;
}

export function AgentConfigEditor({ agentId, onClose, onSaved }: Props) {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const setSessions = useAppStore((s) => s.setSessions);
  const sessions = useAppStore((s) => s.sessions);
  const agent = agents.find((a) => a.id === agentId);

  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [skills, setSkills] = useState<EditableSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showReplaceWarning, setShowReplaceWarning] = useState(false);
  const [presetList, setPresetList] = useState<{ name: string; description: string }[]>([]);
  const [showPresetPicker, setShowPresetPicker] = useState(false);
  const [selectedPresets, setSelectedPresets] = useState<Set<string>>(new Set());
  const initializedFor = useRef<string | null>(null);

  useEffect(() => {
    // Only re-initialize when editing a different agent, not on every store update
    if (initializedFor.current === agentId) return;
    const a = agents.find((x) => x.id === agentId);
    if (a) {
      setDisplayName(a.displayName || '');
      setDescription(a.description || '');
      setSystemPrompt(a.systemPrompt);
      setSkills((a.skills || []) as EditableSkill[]);
      setLoading(false);
      initializedFor.current = agentId;
    }
  }, [agentId, agents]);

  useEffect(() => {
    api.getPresetSkills().then(setPresetList).catch(() => setPresetList([]));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const cleanSkills: SkillDef[] = skills.map(({ _editing, _isNew, ...s }) => s);
      const updated = await api.updateAgent(agentId, {
        displayName,
        description,
        systemPrompt,
        skills: cleanSkills.length > 0 ? cleanSkills : null,
      });
      // Update agents store
      const currentAgents = useAppStore.getState().agents;
      setAgents(currentAgents.map((a) => (a.id === agentId ? { ...a, ...updated } : a)));
      // Update session titles if displayName changed
      const currentSessions = useAppStore.getState().sessions;
      if (agent && agent.displayName !== displayName) {
        setSessions(currentSessions.map(s => {
          if (s.type === 'solo' && s.agents?.[0]?.agentId === agentId) {
            return { ...s, title: displayName, agents: [{ ...s.agents[0], displayName }] };
          }
          return s;
        }));
      }
      onSaved?.();
    } catch (err: any) {
      setError(err.message || 'Failed to save config');
    } finally {
      setSaving(false);
    }
  };

  const handleResetAll = () => {
    if (agent) {
      setDisplayName(agent.displayName || '');
      setDescription(agent.description || '');
      setSystemPrompt(agent.systemPrompt);
      setSkills((agent.skills || []) as EditableSkill[]);
    }
  };

  // --- Skills management ---

  const addSkill = () => {
    setSkills([
      ...skills,
      { name: '', description: '', content: '', _editing: true, _isNew: true },
    ]);
    setShowReplaceWarning(true);
  };

  const startEditSkill = (idx: number) => {
    setSkills(skills.map((s, i) => (i === idx ? { ...s, _editing: true } : s)));
  };

  const updateSkillField = (idx: number, field: keyof EditableSkill, value: string) => {
    setSkills(skills.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };

  const saveSkillEdit = (idx: number) => {
    const skill = skills[idx];
    if (!skill.name || !skill.description || !skill.content) return;
    setSkills(skills.map((s, i) => (i === idx ? { ...s, _editing: false, _isNew: false } : s)));
  };

  const cancelSkillEdit = (idx: number) => {
    if (skills[idx]._isNew) {
      setSkills(skills.filter((_, i) => i !== idx));
    } else {
      setSkills(skills.map((s, i) => (i === idx ? { ...s, _editing: false } : s)));
    }
  };

  const removeSkill = (idx: number) => {
    setSkills(skills.filter((_, i) => i !== idx));
  };

  // --- File upload ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const result = await api.validateSkillFile(file);
      if (result.valid && result.skill) {
        setSkills([
          ...skills,
          { ...result.skill, _editing: false, _isNew: false },
        ]);
        setShowReplaceWarning(true);
      } else {
        setUploadError(result.errors?.map((e) => e.message).join('; ') || 'Validation failed');
      }
    } catch (err: any) {
      setUploadError(err.message || 'Failed to validate file');
    } finally {
      setUploading(false);
    }
    // Reset input
    e.target.value = '';
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-hub-surface rounded-lg shadow-xl p-6 text-hub-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-hub-surface rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-hub">
          <h3 className="text-body font-semibold text-hub-primary">
            Configure: {agent?.displayName || agent?.name}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Display Name */}
          <div>
            <label className="text-sm font-medium text-hub-primary mb-2 block">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-hub-raised border border-hub
                         text-hub-primary text-sm focus:border-hub-accent focus:outline-none"
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium text-hub-primary mb-2 block">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-hub-raised border border-hub
                         text-hub-primary text-sm focus:border-hub-accent focus:outline-none"
            />
          </div>

          {/* System Prompt */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-hub-primary">
                System Prompt
              </label>
              {systemPrompt !== agent?.systemPrompt && (
                <button
                  onClick={() => agent && setSystemPrompt(agent.systemPrompt)}
                  className="flex items-center gap-1 text-xs text-hub-muted hover:text-hub-accent"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset to default
                </button>
              )}
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="w-full h-36 px-3 py-2 rounded-lg bg-hub-raised border border-hub
                         text-hub-primary text-sm font-mono resize-none focus:border-hub-accent focus:outline-none"
            />
          </div>

          {/* Skills */}
          <div>
            <label className="text-sm font-medium text-hub-primary mb-2 block">
              Skills
            </label>

            {/* Replace warning */}
            {showReplaceWarning && skills.length > 0 && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-hub-warning/10 border border-hub-warning/20 mb-3">
                <AlertTriangle className="w-4 h-4 text-hub-warning flex-shrink-0 mt-0.5" />
                <p className="text-xs text-hub-warning">
                  Custom skills will <strong>completely replace</strong> the agent's default skills.
                  Save to apply your changes globally across all sessions using this agent.
                </p>
              </div>
            )}

            {/* Skill list */}
            {skills.length === 0 ? (
              <p className="text-xs text-hub-muted py-3">No custom skills defined. The agent uses its default skills.</p>
            ) : (
              <div className="space-y-2 mb-3">
                {skills.map((skill, idx) => (
                  <div key={idx} className="border border-hub rounded-lg overflow-hidden">
                    {skill._editing ? (
                      /* Edit mode */
                      <div className="p-3 space-y-2 bg-hub-raised">
                        <input
                          type="text"
                          value={skill.name}
                          onChange={(e) => updateSkillField(idx, 'name', e.target.value)}
                          placeholder="Skill name (kebab-case)"
                          className="w-full px-2 py-1 rounded bg-hub-surface border border-hub text-hub-primary text-sm focus:border-hub-accent focus:outline-none"
                        />
                        <input
                          type="text"
                          value={skill.description}
                          onChange={(e) => updateSkillField(idx, 'description', e.target.value)}
                          placeholder="Description"
                          className="w-full px-2 py-1 rounded bg-hub-surface border border-hub text-hub-primary text-sm focus:border-hub-accent focus:outline-none"
                        />
                        <textarea
                          value={skill.content}
                          onChange={(e) => updateSkillField(idx, 'content', e.target.value)}
                          placeholder="Skill content (markdown, without frontmatter)"
                          className="w-full h-24 px-2 py-1 rounded bg-hub-surface border border-hub text-hub-primary text-sm font-mono resize-none focus:border-hub-accent focus:outline-none"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => cancelSkillEdit(idx)}
                            className="px-2 py-1 text-xs text-hub-muted hover:text-hub-secondary"
                          >
                            Cancel
                          </button>
                          <button onClick={() => saveSkillEdit(idx)}
                            disabled={!skill.name || !skill.description || !skill.content}
                            className="px-3 py-1 text-xs bg-hub-accent text-white rounded hover:bg-hub-accent/90 disabled:opacity-40 transition"
                          >
                            Done
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* View mode */
                      <div className="flex items-center justify-between px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium text-hub-primary">{skill.name}</span>
                          <span className="text-xs text-hub-tertiary ml-2 truncate">{skill.description}</span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                          <button onClick={() => startEditSkill(idx)}
                            className="p-1 rounded hover:bg-hub-hover text-hub-muted hover:text-hub-accent"
                            title="Edit skill"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => removeSkill(idx)}
                            className="p-1 rounded hover:bg-hub-hover text-hub-muted hover:text-hub-danger"
                            title="Delete skill"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add / Upload buttons */}
            <div className="flex items-center gap-2">
              <button onClick={addSkill}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded border border-hub-accent/30 text-hub-accent hover:bg-hub-accent/10 transition"
              >
                <Plus className="w-3 h-3" /> Add Skill
              </button>
              <label className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded border border-hub-accent/30 text-hub-accent hover:bg-hub-accent/10 transition cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                <Upload className="w-3 h-3" /> {uploading ? 'Validating...' : 'Upload .md'}
                <input type="file" accept=".md" onChange={handleFileUpload} className="hidden" />
              </label>
              <button
                onClick={() => { setShowPresetPicker(true); setSelectedPresets(new Set()); }}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded border border-hub-accent/30 text-hub-accent hover:bg-hub-accent/10 transition"
              >
                <Package className="w-3 h-3" /> Add from Presets
              </button>
            </div>

            {/* Upload error */}
            {uploadError && (
              <div className="mt-2 p-2 rounded bg-hub-danger/10 border border-hub-danger/20 text-hub-danger text-xs">
                {uploadError}
              </div>
            )}

            {/* Preset picker modal */}
            {showPresetPicker && (
              <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
                <div className="bg-hub-surface rounded-lg shadow-xl w-full max-w-md max-h-[70vh] flex flex-col">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-hub">
                    <h3 className="text-sm font-semibold text-hub-primary">Add Preset Skills</h3>
                    <button onClick={() => setShowPresetPicker(false)} className="p-1 rounded hover:bg-hub-hover text-hub-muted">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-1">
                    {presetList
                      .filter(p => !skills.some(s => s.name === p.name))
                      .map(p => (
                        <label key={p.name} className="flex items-start gap-2 py-1.5 cursor-pointer hover:bg-hub-hover/50 rounded px-1">
                          <input
                            type="checkbox"
                            checked={selectedPresets.has(p.name)}
                            onChange={e => {
                              const next = new Set(selectedPresets);
                              e.target.checked ? next.add(p.name) : next.delete(p.name);
                              setSelectedPresets(next);
                            }}
                            className="mt-0.5 rounded border-hub bg-hub-input text-hub-accent focus:ring-hub-accent"
                          />
                          <div>
                            <div className="text-sm font-medium text-hub-primary">{p.name}</div>
                            <div className="text-xs text-hub-tertiary">{p.description}</div>
                          </div>
                        </label>
                      ))}
                    {presetList.filter(p => !skills.some(s => s.name === p.name)).length === 0 && (
                      <p className="text-xs text-hub-muted py-4 text-center">All preset skills already added.</p>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hub">
                    <button onClick={() => setShowPresetPicker(false)} className="px-3 py-1.5 text-xs text-hub-secondary hover:bg-hub-hover rounded">Cancel</button>
                    <button
                      onClick={async () => {
                        if (selectedPresets.size === 0) return;
                        const names = Array.from(selectedPresets);
                        try {
                          const token = localStorage.getItem('agenthub_token');
                          const res = await fetch(`/api/agents/${agentId}/skills`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ skillNames: names }),
                          });
                          if (!res.ok) {
                            const err = await res.json().catch(() => ({ error: 'Failed to add skills' }));
                            throw new Error(err.error || 'Failed to add skills');
                          }
                          // Refresh agents to get updated skills
                          api.getAgents().then(useAppStore.getState().setAgents);
                          setShowPresetPicker(false);
                        } catch (err: any) {
                          setError(err.message || 'Failed to add skills');
                        }
                      }}
                      disabled={selectedPresets.size === 0}
                      className="px-4 py-1.5 text-xs bg-hub-accent text-white rounded hover:bg-hub-accent/90 disabled:opacity-40 transition"
                    >
                      Add ({selectedPresets.size})
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Global config notice */}
          <div className="p-3 rounded-lg bg-hub-link/10 border border-hub-link/20">
            <p className="text-xs text-hub-link">
              Modifications apply to the <strong>global agent configuration</strong>.
              All sessions referencing this agent will use the updated settings.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg bg-hub-danger/10 border border-hub-danger/20 text-hub-danger text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-hub">
          <button
            onClick={handleResetAll}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-hub-muted hover:text-hub-secondary hover:bg-hub-hover transition"
            title="Revert all fields to saved values"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to default
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-hub-secondary hover:bg-hub-hover transition"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-hub-accent text-white text-sm
                         hover:bg-hub-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {saving ? (
                <span className="animate-spin">⏳</span>
              ) : (
                <Save className="w-4 h-4" />
              )}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
