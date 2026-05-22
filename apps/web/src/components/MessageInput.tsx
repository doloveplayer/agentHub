import { useState, useRef, KeyboardEvent } from 'react';
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
  onSend: (content: string, mentionedAgents: MentionTag[]) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled }: Props) {
  const agents = useAppStore((s) => s.agents);
  const trustMode = useAppStore((s) => s.trustMode);
  const setTrustMode = useAppStore((s) => s.setTrustMode);
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

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const pos = e.target.selectionStart ?? 0;
    setValue(newValue);
    setCursorPos(pos);

    const textBefore = newValue.slice(0, pos);
    // Check for @mention first
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

    // Check for / command at start of input
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
    // Slash command keyboard nav
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
    onSend(trimmed, tags);
    setValue('');
    setTags([]);
    ref.current?.focus();
  };

  return (
    <div className="border-t border-gray-800 p-4">
      {tags.length > 0 && (
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {tags.map((tag) => (
            <span key={tag.agentId}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-900/50 border border-purple-700 rounded-full text-xs text-purple-300"
            >
              @{tag.displayName}
              <button onClick={() => removeTag(tag.agentId)} className="ml-0.5 hover:text-white">&times;</button>
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
          className="flex-1 bg-gray-800 text-gray-200 rounded-lg px-4 py-3 resize-none focus:outline-none focus:ring-1 focus:ring-purple-500 text-sm"
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

        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none shrink-0" title="When off, permission requests are sent to you for approval">
          <input
            type="checkbox"
            checked={trustMode}
            onChange={(e) => setTrustMode(e.target.checked)}
            className="rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500"
          />
          Trust
        </label>

        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="p-3 bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}