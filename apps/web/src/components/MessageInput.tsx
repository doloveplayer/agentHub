import { useEffect, useState, useRef, KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { AgentMentionPopup } from './AgentMentionPopup';
import { SlashCommandPopup } from './SlashCommandPopup';
import { recommendAgents } from '../lib/mentionParser';
import type { AgentConfig } from '@agenthub/shared';

interface MentionTag {
  agentId: string;
  agentName: string;
  displayName: string;
}

interface Props {
  onSend: (content: string, mentionedAgents: MentionTag[], mode?: 'parallel' | 'sequential') => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled }: Props) {
  const agents = useAppStore((s) => s.agents);
  const trustMode = useAppStore((s) => s.trustMode);
  const setTrustMode = useAppStore((s) => s.setTrustMode);
  const orchestrationMode = useAppStore((s) => s.orchestrationMode);
  const setOrchestrationMode = useAppStore((s) => s.setOrchestrationMode);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const messages = useAppStore((s) => s.messages);
  const recentMessages = (messages[activeSessionId ?? ''] ?? []).slice(-20).map(m => m.content).filter(Boolean);
  const [value, setValue] = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [tags, setTags] = useState<MentionTag[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [slashQuery, setSlashQuery] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);

  const matchedAgents = recommendAgents(mentionQuery, agents, recentMessages);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt: string }>).detail;
      if (!detail?.prompt) return;
      setValue((current) => `${current.trim() ? `${current.trim()}\n\n` : ''}${detail.prompt}`);
      ref.current?.focus();
    };
    window.addEventListener('agenthub:prompt-insert', handler);
    return () => window.removeEventListener('agenthub:prompt-insert', handler);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const pos = e.target.selectionStart ?? 0;
    setValue(newValue);
    setCursorPos(pos);

    const textBefore = newValue.slice(0, pos);
    const atMatch = textBefore.match(/@(\S*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setShowPopup(true);
      setShowSlash(false);
      setFocusedIndex(0);
      return;
    }
    setShowPopup(false);
    setMentionQuery('');

    const slashMatch = textBefore.match(/^\/(\S*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
      setShowSlash(true);
      setSlashIndex(0);
    } else {
      setShowSlash(false);
      setSlashQuery('');
    }
  };

  const handleSelectAgent = (agent: AgentConfig) => {
    const textBefore = value.slice(0, cursorPos);
    const textAfter = value.slice(cursorPos);
    const newBefore = textBefore.replace(/@\S*$/, `@${agent.displayName} `);
    setValue(newBefore + textAfter);
    setShowPopup(false);
    setMentionQuery('');

    setTags((prev) => {
      const filtered = prev.filter((t) => t.agentId !== agent.id);
      return [...filtered, { agentId: agent.id, agentName: agent.name, displayName: agent.displayName }];
    });

    ref.current?.focus();
  };

  const handleSelectCommand = (command: string) => {
    setValue(command + ' ');
    setShowSlash(false);
    setSlashQuery('');
    ref.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showSlash) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % 8); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => (i - 1 + 8) % 8); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const filtered = slashQuery
          ? ['/plan','/review','/fix','/deploy','/init','/test','/audit','/compact'].filter(c => c.startsWith(slashQuery))
          : ['/plan','/review','/fix','/deploy','/init','/test','/audit','/compact'];
        if (filtered[slashIndex]) handleSelectCommand(filtered[slashIndex]);
        return;
      }
      if (e.key === 'Escape') { setShowSlash(false); return; }
    }

    if (showPopup && matchedAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((i) => (i + 1) % matchedAgents.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((i) => (i - 1 + matchedAgents.length) % matchedAgents.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSelectAgent(matchedAgents[focusedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setShowPopup(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const removeTag = (agentId: string) => {
    setTags((prev) => prev.filter((t) => t.agentId !== agentId));
  };

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, tags, orchestrationMode);
    setValue('');
    setTags([]);
    ref.current?.focus();
  };

  return (
    <div className="border-t border-white/[0.06] p-4">
      {tags.length > 0 && (
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {tags.map((tag) => (
            <span key={tag.agentId}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-accent/15 border border-accent/30 rounded-sm text-footnote text-accent/90"
            >
              @{tag.displayName}
              <button onClick={() => removeTag(tag.agentId)} className="ml-0.5 hover:text-white transition">&times;</button>
            </span>
          ))}
        </div>
      )}

      <div className="relative flex gap-2 items-end">
        <textarea
          ref={ref}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... @ to mention an agent"
          rows={1}
          className="flex-1 bg-white/[0.06] text-white/85 rounded-md px-4 py-3 resize-none focus:outline-none focus:ring-1 focus:ring-accent text-body placeholder:text-white/20"
          disabled={disabled}
        />

        {showPopup && (
          <AgentMentionPopup
            agents={matchedAgents}
            query={mentionQuery}
            focusedIndex={focusedIndex}
            onSelect={handleSelectAgent}
            onClose={() => setShowPopup(false)}
            position={{ top: 0, left: 8 }}
          />
        )}

        {showSlash && (
          <SlashCommandPopup
            query={slashQuery}
            focusedIndex={slashIndex}
            onSelect={handleSelectCommand}
            onClose={() => setShowSlash(false)}
            position={{ top: 0, left: 8 }}
          />
        )}

        <select
          value={orchestrationMode}
          onChange={(e) => setOrchestrationMode(e.target.value as 'parallel' | 'sequential')}
          className="text-footnote bg-white/[0.06] text-white/50 rounded-sm px-1.5 py-1 border border-white/[0.08] focus:outline-none focus:ring-1 focus:ring-accent cursor-pointer shrink-0"
          title="Orchestration mode: parallel runs all @mentioned agents at once, sequential runs them one after another"
        >
          <option value="parallel">∥</option>
          <option value="sequential">→</option>
        </select>

        <label className="flex items-center gap-1.5 text-footnote text-white/30 cursor-pointer select-none shrink-0" title="When off, permission requests are sent to you for approval">
          <input
            type="checkbox"
            checked={trustMode}
            onChange={(e) => setTrustMode(e.target.checked)}
            className="rounded-sm border-white/[0.12] bg-white/[0.06] text-accent focus:ring-accent"
          />
          Trust
        </label>

        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="p-3 bg-accent text-white rounded-md hover:bg-accent-hover active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
