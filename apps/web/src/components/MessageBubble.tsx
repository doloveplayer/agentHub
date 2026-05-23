import { useState } from 'react';
import { User, Copy, Check } from 'lucide-react';
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
  const [copied, setCopied] = useState(false);
  const isHuman = message.senderType === 'human';
  const nameForKey = agentName || message.agentId || 'agent';

  const handleCopy = async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };
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
          {message.content && message.status === 'done' && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:bg-white/10"
              title="复制"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-gray-500" />}
            </button>
          )}
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
