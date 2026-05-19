import { useEffect, useRef } from 'react';
import type { AgentConfig } from '@agenthub/shared';

interface Props {
  agents: AgentConfig[];
  query: string;
  focusedIndex: number;
  onSelect: (agent: AgentConfig) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

export function agentColor(name: string): string {
  const colors: Record<string, string> = {
    'code-agent': '#7c3aed',
    'review-agent': '#059669',
    'devops-agent': '#ea580c',
  };
  return colors[name] ?? '#6b7280';
}

export function AgentMentionPopup({ agents, query, focusedIndex, onSelect, onClose, position }: Props) {
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  if (agents.length === 0) return null;

  return (
    <div
      ref={popupRef}
      className="absolute z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl w-56 overflow-hidden"
      style={{ bottom: '100%', left: position.left, marginBottom: 4 }}
    >
      {agents.map((agent, i) => (
        <div
          key={agent.id}
          className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
            i === focusedIndex ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700'
          }`}
          onMouseDown={(e) => { e.preventDefault(); onSelect(agent); }}
        >
          <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
            style={{ backgroundColor: agentColor(agent.name) }}
          >
            {agent.displayName.charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{agent.displayName}</div>
            <div className="text-[10px] text-gray-500 truncate">{agent.description}</div>
          </div>
          <span className="text-[10px] text-gray-500 ml-auto">@{agent.name.charAt(0)}</span>
        </div>
      ))}
    </div>
  );
}