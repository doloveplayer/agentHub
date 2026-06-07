import { useState, useEffect, useMemo } from 'react';
import { X, Search, ChevronDown } from 'lucide-react';
import { api } from '../lib/api';
import { useAppStore } from '../store/appStore';
import type { SkillDef } from '@agenthub/shared';

// ── Template definitions ────────────────────────────────────────────

interface TemplateDef {
  key: string;
  label: string;
  description: string;
  defaultSkills: string[];
}

const TEMPLATES: TemplateDef[] = [
  {
    key: 'code-agent',
    label: 'CodeAgent',
    description: 'Writes and modifies code, runs shell commands, creates files',
    defaultSkills: ['karpathy-guidelines'],
  },
  {
    key: 'review-agent',
    label: 'ReviewAgent',
    description: 'Reviews code for bugs, security vulnerabilities, and style issues',
    defaultSkills: ['karpathy-guidelines'],
  },
  {
    key: 'devops-agent',
    label: 'DevOpsAgent',
    description: 'Handles deployment, CI/CD, Docker, and infrastructure tasks',
    defaultSkills: [],
  },
  {
    key: 'test-agent',
    label: 'TestAgent',
    description: 'Generates tests, runs test suites, and reports results',
    defaultSkills: [],
  },
  {
    key: 'custom',
    label: 'Custom',
    description: 'Start from scratch',
    defaultSkills: [],
  },
];

// ── Skill groups ────────────────────────────────────────────────────

const SKILL_GROUPS: Record<string, string[]> = {
  Quality: [
    'karpathy-guidelines',
    'systematic-debugging',
    'test-driven-development',
    'verification-before-completion',
    'requesting-code-review',
    'receiving-code-review',
  ],
  Workflow: [
    'brainstorming',
    'writing-plans',
    'writing-skills',
    'executing-plans',
    'subagent-driven-development',
    'dispatching-parallel-agents',
    'finishing-a-development-branch',
    'using-git-worktrees',
  ],
  Creative: [
    'frontend-design',
    'canvas-design',
    'algorithmic-art',
    'theme-factory',
    'web-artifacts-builder',
    'slack-gif-creator',
  ],
  Documents: [
    'docx',
    'xlsx',
    'pptx',
    'pdf',
    'pdf-generator',
    'doc-coauthoring',
    'internal-comms',
    'claude-api',
    'mcp-builder',
    'webapp-testing',
    'brand-guidelines',
    'skill-creator',
    'cc-nano-banana',
    'archive-experience',
  ],
};

// Which groups are expanded by default
const DEFAULT_EXPANDED = new Set(['Quality', 'Workflow']);

// ── Props ────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  groupSessionId?: string;
  /** Called after successful creation (agent + session/add). onClose handles cancel. */
  onCreated?: () => void;
}

// ── Component ────────────────────────────────────────────────────────

export function CreateAgentModal({ open, onClose, groupSessionId, onCreated }: Props) {
  // ---- Store ----
  const agents = useAppStore((s) => s.agents);

  // ---- Form state ----
  const [selectedTemplate, setSelectedTemplate] = useState<string>('code-agent');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [provider, setProvider] = useState('claude-code');

  // ---- UI state ----
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presetSkills, setPresetSkills] = useState<{ name: string; description: string }[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(DEFAULT_EXPANDED);

  // ---- Load preset skills on open ----
  useEffect(() => {
    if (!open) return;
    api.getPresetSkills()
      .then(setPresetSkills)
      .catch(() => setPresetSkills([]));
  }, [open]);

  // ---- Build description lookup map and dynamic groups from fetched preset skills ----
  const { skillDescriptionMap, skillGroups } = useMemo(() => {
    const map: Record<string, string> = {};
    const grouped = new Set<string>();
    const groups: Record<string, string[]> = { ...SKILL_GROUPS };
    for (const s of presetSkills) {
      map[s.name] = s.description;
      for (const names of Object.values(groups)) {
        if (names.includes(s.name)) grouped.add(s.name);
      }
    }
    // Add unmatched preset skills to "Other"
    const other = presetSkills.filter(s => !grouped.has(s.name)).map(s => s.name);
    if (other.length > 0) groups['Other'] = other;
    return { skillDescriptionMap: map, skillGroups: groups };
  }, [presetSkills]);

  // ---- Reset form on open ----
  useEffect(() => {
    if (!open) return;
    setSelectedTemplate('code-agent');
    setDisplayName('CodeAgent');
    setDescription('Writes and modifies code, runs shell commands, creates files');
    setSystemPrompt('');
    setSelectedSkills(new Set(['karpathy-guidelines']));
    setSearchQuery('');
    setProvider('claude-code');
    setError(null);
    setCreating(false);

    // Pre-fill systemPrompt from the store (match by name, any type)
    const storeAgents = useAppStore.getState().agents;
    const codeAgent = storeAgents.find((a) => a.name === 'code-agent');
    if (codeAgent?.systemPrompt) {
      setSystemPrompt(codeAgent.systemPrompt);
    }
  }, [open]);

  // ---- Handle template selection ----
  const handleTemplateSelect = (template: TemplateDef) => {
    setSelectedTemplate(template.key);
    // Set default skills from template definition
    setSelectedSkills(new Set(template.defaultSkills));

    if (template.key === 'custom') {
      setDisplayName('');
      setDescription('');
      setSystemPrompt('');
      return;
    }

    setDisplayName(template.label);
    setDescription(template.description);

    // Look up matching agent from the store for systemPrompt pre-fill (by name, any type)
    const match = useAppStore.getState().agents.find((a) => a.name === template.key);
    setSystemPrompt(match?.systemPrompt ?? '');
  };

  // ---- Toggle a skill checkbox ----
  const toggleSkill = (skillName: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) {
        next.delete(skillName);
      } else {
        next.add(skillName);
      }
      return next;
    });
  };

  // ---- Toggle a group expand/collapse ----
  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  // ---- Filtered skill groups based on search ----
  const filteredGroups = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const result: { group: string; skills: string[] }[] = [];

    for (const [group, skills] of Object.entries(skillGroups)) {
      if (!q) {
        result.push({ group, skills });
        continue;
      }
      const filtered = skills.filter((s) => s.toLowerCase().includes(q));
      if (filtered.length > 0) {
        result.push({ group, skills: filtered });
      }
    }
    return result;
  }, [searchQuery]);

  // ---- Total selected count ----
  const totalSelected = selectedSkills.size;

  // ---- Create handler ----
  const handleCreate = async () => {
    if (!displayName || !description || !systemPrompt) return;
    setCreating(true);
    setError(null);
    try {
      // Derive machine-readable name from displayName; fallback for non-ASCII input
      let name = displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
      if (name.length < 2) {
        name = 'agent-' + Date.now().toString(36).slice(-6);
      }
      const skills: SkillDef[] = Array.from(selectedSkills).map((sName) => ({
        name: sName,
        description: '',
        content: '',
      }));
      const agent = await api.createAgent({
        name,
        displayName,
        description,
        systemPrompt,
        provider,
        skills,
      });

      try {
        if (groupSessionId) {
          await api.addSessionAgents(groupSessionId, [agent.id]);
        } else {
          const session = await api.createSession({
            type: 'solo',
            agentIds: [agent.id],
          });
          useAppStore.getState().setActiveSession(session.id);
        }
      } catch (sessionErr: any) {
        // Rollback: delete the orphaned agent
        api.deleteAgent(agent.id).catch(() => {});
        setError(`Agent created but session failed: ${sessionErr.message || 'Unknown error'}`);
        setCreating(false);
        return;
      }

      // Refresh stores
      Promise.all([
        api.getAgents().then(useAppStore.getState().setAgents),
        api.getSessions().then(useAppStore.getState().setSessions),
      ]).catch(() => {});

      onCreated?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  // ---- Don't render anything if not open ----
  if (!open) return null;

  // ---- Render helpers ──────────────────────────────────────────────

  const renderSkillCheckbox = (skillName: string) => {
    const desc = skillDescriptionMap[skillName] || '';
    const isChecked = selectedSkills.has(skillName);
    return (
      <label
        key={skillName}
        className="flex items-start gap-2.5 py-1.5 px-2 rounded hover:bg-hub-hover cursor-pointer transition-colors"
      >
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => toggleSkill(skillName)}
          className="mt-0.5 h-3.5 w-3.5 rounded border-hub-border bg-hub-input accent-hub-accent cursor-pointer flex-shrink-0"
        />
        <div className="min-w-0">
          <span className="text-[13px] font-medium text-hub-primary">{skillName}</span>
          {desc && (
            <span className="block text-[11px] text-hub-tertiary truncate mt-0.5">
              {desc}
            </span>
          )}
        </div>
      </label>
    );
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="glass-surface-heavy border border-hub rounded-hub-xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-hub flex-shrink-0">
          <h2 className="text-body font-semibold text-hub-primary">Create Agent</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-hub-hover text-hub-muted hover:text-hub-primary transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* ---------- Template cards ---------- */}
          <div>
            <label className="text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider mb-2 block">
              Template
            </label>
            <div className="grid grid-cols-5 gap-2">
              {TEMPLATES.map((tpl) => {
                const selected = selectedTemplate === tpl.key;
                return (
                  <button
                    key={tpl.key}
                    onClick={() => handleTemplateSelect(tpl)}
                    className={`rounded-hub-lg border-2 p-3 text-left transition-colors ${
                      selected
                        ? 'border-hub-accent bg-hub-accent/10'
                        : 'border-hub hover:border-hub-border-2 hover:bg-hub-hover'
                    }`}
                  >
                    <div className="text-[13px] font-semibold text-hub-primary mb-1">
                      {tpl.label}
                    </div>
                    <div className="text-[10px] text-hub-tertiary leading-tight">
                      {tpl.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ---------- Display Name ---------- */}
          <div>
            <label
              htmlFor="agent-display-name"
              className="text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider mb-1.5 block"
            >
              Display Name
            </label>
            <input
              id="agent-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="My Agent"
              className="w-full bg-hub-raised border border-hub rounded-hub-lg px-3 py-2 text-sm text-hub-primary placeholder:text-hub-muted focus:outline-none focus:border-hub-accent transition-colors"
            />
          </div>

          {/* ---------- Description ---------- */}
          <div>
            <label
              htmlFor="agent-description"
              className="text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider mb-1.5 block"
            >
              Description
            </label>
            <input
              id="agent-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this agent do?"
              className="w-full bg-hub-raised border border-hub rounded-hub-lg px-3 py-2 text-sm text-hub-primary placeholder:text-hub-muted focus:outline-none focus:border-hub-accent transition-colors"
            />
          </div>

          {/* ---------- System Prompt ---------- */}
          <div>
            <label
              htmlFor="agent-system-prompt"
              className="text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider mb-1.5 block"
            >
              System Prompt
            </label>
            <textarea
              id="agent-system-prompt"
              rows={6}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful AI assistant..."
              className="w-full bg-hub-raised border border-hub rounded-hub-lg px-3 py-2 text-sm text-hub-primary placeholder:text-hub-muted font-mono resize-none focus:outline-none focus:border-hub-accent transition-colors"
            />
          </div>

          {/* ---------- Platform ---------- */}
          <div>
            <label
              htmlFor="agent-platform"
              className="text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider mb-1.5 block"
            >
              Platform
            </label>
            <select
              id="agent-platform"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full bg-hub-raised border border-hub rounded-hub-lg px-3 py-2 text-sm text-hub-primary focus:outline-none focus:border-hub-accent transition-colors appearance-none cursor-pointer"
            >
              <option value="claude-code">Claude Code</option>
              <option value="opencode">OpenCode</option>
            </select>
          </div>

          {/* ---------- Skills ---------- */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-semibold text-hub-tertiary uppercase tracking-wider">
                Skills {totalSelected > 0 && `(${totalSelected} selected)`}
              </label>
            </div>

            {/* Search input */}
            <div className="relative mb-3">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hub-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter skills..."
                className="w-full bg-hub-raised border border-hub rounded-hub-lg pl-8 pr-3 py-2 text-sm text-hub-primary placeholder:text-hub-muted focus:outline-none focus:border-hub-accent transition-colors"
              />
            </div>

            {/* Skill groups */}
            <div className="space-y-1 bg-hub-raised rounded-hub-lg border border-hub p-1 max-h-64 overflow-y-auto">
              {filteredGroups.length === 0 ? (
                <div className="px-3 py-4 text-sm text-hub-tertiary text-center">
                  No skills match your search.
                </div>
              ) : (
                filteredGroups.map(({ group, skills }) => {
                  const isExpanded = searchQuery ? true : expandedGroups.has(group);
                  const groupSelected = skills.filter((s) => selectedSkills.has(s)).length;
                  return (
                    <details
                      key={group}
                      open={isExpanded}
                      className="group"
                    >
                      <summary
                        onClick={(e) => {
                          // Only handle toggle when not searching
                          if (!searchQuery) {
                            e.preventDefault();
                            toggleGroup(group);
                          }
                        }}
                        className="flex items-center gap-2 px-2 py-2 rounded cursor-pointer text-[12px] font-semibold text-hub-secondary hover:text-hub-primary hover:bg-hub-hover transition-colors select-none"
                      >
                        <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? '' : '-rotate-90'}`} />
                        <span>{group}</span>
                        <span className="ml-auto text-[11px] text-hub-muted font-normal">
                          {groupSelected}/{skills.length}
                        </span>
                      </summary>
                      <div className="pl-5 py-0.5">
                        {skills.map(renderSkillCheckbox)}
                      </div>
                    </details>
                  );
                })
              )}
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="text-[13px] text-hub-danger bg-hub-danger/10 rounded-hub-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-hub flex-shrink-0">
          <button
            onClick={onClose}
            disabled={creating}
            className="px-4 py-2 text-sm text-hub-secondary hover:text-hub-primary rounded-hub-lg hover:bg-hub-hover transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={
              creating ||
              !displayName ||
              !description ||
              !systemPrompt
            }
            className="px-5 py-2 text-sm font-semibold text-white bg-hub-accent hover:bg-hub-accent-hover rounded-hub-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
