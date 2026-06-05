import { useMemo, useEffect, useRef } from 'react';

const SLASH_COMMANDS = [
  { name: '/plan', description: 'Create a task plan (Planner Agent)', icon: '📋' },
  { name: '/review', description: 'Request a code review', icon: '🔍' },
  { name: '/fix', description: 'Fix a bug or issue', icon: '🔧' },
  { name: '/deploy', description: 'Deploy the project', icon: '🚀' },
  { name: '/init', description: 'Initialize a new project', icon: '🌟' },
  { name: '/test', description: 'Generate and run tests', icon: '🧪' },
  { name: '/audit', description: 'Security audit of dependencies', icon: '🛡️' },
  { name: '/compact', description: 'Compact conversation context', icon: '📦' },
];

interface SkillItem {
  name: string;
  description: string;
  agentDisplayName?: string;
}

interface Props {
  query: string;
  focusedIndex: number;
  onSelect: (command: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
  agentSkills?: SkillItem[];
}

export function SlashCommandPopup({ query, focusedIndex, onSelect, onClose, position, agentSkills }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allCommands = useMemo(() => {
    const skills: { name: string; description: string; icon: string; agentDisplayName?: string }[] = (agentSkills || []).map(s => ({
      name: '/' + s.name,
      description: s.description,
      icon: '🔧',
      agentDisplayName: s.agentDisplayName,
    }));
    return [...SLASH_COMMANDS.map(c => ({ ...c, agentDisplayName: undefined as string | undefined })), ...skills];
  }, [agentSkills]);

  // Auto-scroll focused item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const filtered = query
    ? allCommands.filter((c) => c.name.startsWith(query) || c.name.includes(query.slice(1)))
    : allCommands;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={ref}
      className="absolute z-50 bg-hub-raised border border-hub rounded-hub-lg shadow-2xl w-56 overflow-hidden"
      style={{ bottom: '100%', left: position.left, marginBottom: 8 }}
    >
      <div className="px-3 py-1.5 border-b border-hub">
        <span className="text-[10px] text-hub-muted font-medium">Commands</span>
      </div>
      <div ref={listRef} className="max-h-56 overflow-y-auto">
        {filtered.map((cmd, i) => (
          <div
            key={cmd.name + (cmd.agentDisplayName || '')}
            data-index={i}
            onClick={() => onSelect(cmd.name)}
            className={`px-3 py-2 flex items-center gap-2.5 cursor-pointer transition text-sm ${
              i === focusedIndex ? 'bg-hub-active text-hub-primary' : 'text-hub-tertiary hover:bg-hub-hover hover:text-hub-secondary'
            }`}
          >
            <span className="text-xs w-5 text-center">{cmd.icon}</span>
            <span className="font-medium font-mono text-xs">{cmd.name}</span>
            <span className="text-[11px] text-hub-muted flex-1 truncate">{cmd.description}</span>
            {cmd.agentDisplayName && (
              <span className="text-[10px] text-hub-muted shrink-0 ml-1">{cmd.agentDisplayName}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
