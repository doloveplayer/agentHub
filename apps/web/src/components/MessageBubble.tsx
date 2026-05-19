import { User } from 'lucide-react';
import type { Message } from '@agenthub/shared';
import { agentColor } from './AgentMentionPopup';

interface Props {
  message: Message;
  isStreaming?: boolean;
  agentDisplayName?: string;
  agentName?: string;
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

  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className={`flex gap-3 px-4 py-2.5 group ${isHuman ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-xs font-semibold shadow-sm"
        style={{ backgroundColor: isHuman ? '#3b82f6' : (color ?? '#475569'), color: '#fff' }}
      >
        {isHuman ? <User className="w-4 h-4" /> : initial}
      </div>
      <div className={`max-w-[72%] ${isHuman ? 'items-end' : 'items-start'}`}>
        <div className={`flex items-center gap-2 mb-1 ${isHuman ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs text-gray-400 font-medium">{label}</span>
          {time && <span className="text-[10px] text-gray-600">{time}</span>}
        </div>
        <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
          isHuman
            ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white rounded-tr-md'
            : 'bg-slate-800/80 border border-slate-700/50 text-slate-200 rounded-tl-md'
        }`}>
          {message.content ? (
            message.content
          ) : isStreaming ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-4 bg-gray-400 rounded-full streaming-cursor" />
              <span className="w-1.5 h-3 bg-gray-400/60 rounded-full streaming-cursor" style={{ animationDelay: '0.15s' }} />
              <span className="w-1.5 h-2 bg-gray-400/30 rounded-full streaming-cursor" style={{ animationDelay: '0.3s' }} />
            </span>
          ) : (
            <span className="text-gray-500 italic text-xs">{message.status === 'error' ? '[Agent stopped]' : '[No output]'}</span>
          )}
        </div>
      </div>
    </div>
  );
}
