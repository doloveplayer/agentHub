import { User } from 'lucide-react';
import type { Message } from '@agenthub/shared';
import { agentColor } from './AgentMentionPopup';

interface Props {
  message: Message;
  isStreaming?: boolean;
  agentDisplayName?: string;
  agentName?: string;  // kebab-case name for color lookup (e.g. "code-agent")
}

const AGENT_ICONS: Record<string, string> = {
  'code-agent': 'C',
  'review-agent': 'R',
  'devops-agent': 'D',
};

export function MessageBubble({ message, isStreaming, agentDisplayName, agentName }: Props) {
  const isHuman = message.senderType === 'human';
  const nameForKey = agentName || message.agentId || 'agent';
  const color = isHuman ? undefined : agentColor(nameForKey);

  const label = isHuman ? 'You' : (agentDisplayName || 'Agent');
  const initial = isHuman
    ? 'U'
    : (AGENT_ICONS[nameForKey] || (agentDisplayName?.charAt(0) ?? 'A'));

  return (
    <div className={`flex gap-3 px-4 py-3 ${isHuman ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
        style={{ backgroundColor: isHuman ? '#2563eb' : (color ?? '#6b7280'), color: '#fff' }}
      >
        {isHuman ? <User className="w-4 h-4" /> : initial}
      </div>
      <div className={`max-w-[75%] ${isHuman ? 'items-end' : 'items-start'}`}>
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <div className={`rounded-lg px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap font-mono ${
          isHuman ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-200'
        }`}>
          {message.content ? (
            message.content
          ) : isStreaming ? (
            <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse" />
          ) : (
            <span className="text-gray-500 italic">{message.status === 'error' ? '[Agent stopped]' : '[No output]'}</span>
          )}
        </div>
      </div>
    </div>
  );
}