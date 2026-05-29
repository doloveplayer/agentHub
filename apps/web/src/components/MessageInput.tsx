import { useEffect, useState, useRef, KeyboardEvent } from 'react';
import { Send, Paperclip } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { AgentMentionPopup } from './AgentMentionPopup';
import { SlashCommandPopup } from './SlashCommandPopup';
import { recommendAgents } from '../lib/mentionParser';
import { api } from '../lib/api';
import type { AgentConfig, Message } from '@agenthub/shared';

interface MentionTag {
  agentId: string;
  agentName: string;
  displayName: string;
}

interface PromptInsertDetail {
  prompt: string;
  quoteRef?: {
    sourceMessageId?: string;
    selectionText: string;
    sourceType: string;
    contextMeta?: Record<string, unknown>;
  };
}

interface Props {
  onSend: (content: string, mentionedAgents: MentionTag[], mode?: 'parallel' | 'sequential', quoteReferenceId?: string | null) => void;
  disabled?: boolean;
  mentionableAgents?: AgentConfig[];
}

export function MessageInput({ onSend, disabled, mentionableAgents }: Props) {
  const agents = useAppStore((s) => s.agents);
  const trustMode = useAppStore((s) => s.trustMode);
  const setTrustMode = useAppStore((s) => s.setTrustMode);
  const orchestrationMode = useAppStore((s) => s.orchestrationMode);
  const setOrchestrationMode = useAppStore((s) => s.setOrchestrationMode);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeSessionType = useAppStore((s) => s.sessions.find((session: any) => session.id === s.activeSessionId)?.type);
  const addMessage = useAppStore((s) => s.addMessage);
  const messages = useAppStore((s) => s.messages);
  const recentMessages = (messages[activeSessionId ?? ''] ?? []).slice(-20).map(m => m.content).filter(Boolean);
  const [value, setValue] = useState('');
  const [showPopup, setShowPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [tags, setTags] = useState<MentionTag[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [slashQuery, setSlashQuery] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const pendingQuoteRef = useRef<PromptInsertDetail['quoteRef'] | null>(null);

  const matchSource = mentionableAgents ?? agents;
  const matchedAgents = recommendAgents(mentionQuery, matchSource, recentMessages);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<PromptInsertDetail>).detail;
      if (!detail?.prompt) return;
      setValue((current) => `${current.trim() ? `${current.trim()}\n\n` : ''}${detail.prompt}`);
      if (detail.quoteRef) {
        pendingQuoteRef.current = detail.quoteRef;
      }
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
    if (atMatch && activeSessionType === 'group') {
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

  const handleSend = async () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    // Persist QuoteReference before sending, so we have the ID for correlation
    let quoteReferenceId: string | null = null;
    if (pendingQuoteRef.current && activeSessionId) {
      const ref = pendingQuoteRef.current;
      try {
        const created = await api.createQuoteReference({
          sourceMessageId: ref.sourceMessageId || '',
          selectionText: ref.selectionText,
          sourceType: ref.sourceType,
          contextMeta: ref.contextMeta,
          sessionId: activeSessionId,
        });
        quoteReferenceId = (created as any)?.id ?? null;
      } catch { /* proceed without correlation */ }
      pendingQuoteRef.current = null;
    }

    // Intercept /deploy command — trigger deployment workflow instead of chat message
    if (trimmed.startsWith('/deploy')) {
      const target = trimmed.split(/\s+/)[1] || 'docker';
      const validTargets = ['docker', 'vercel', 'cloudflare'];
      if (validTargets.includes(target)) {
        handleDeploy(target);
      } else {
        if (activeSessionId) {
          const msg: Message = {
            id: `deploy-error-${Date.now()}`,
            sessionId: activeSessionId,
            senderType: 'agent',
            content: `Invalid deploy target: ${target}. Supported targets: docker, vercel, cloudflare.`,
            status: 'error',
            createdAt: new Date().toISOString(),
          };
          addMessage(activeSessionId, msg);
        }
      }
      setValue('');
      ref.current?.focus();
      return;
    }

    onSend(trimmed, tags, orchestrationMode, quoteReferenceId);

    setValue('');
    setTags([]);
    ref.current?.focus();
  };

  const handleDeploy = async (target: string) => {
    if (!activeSessionId) return;
    try {
      await api.generateDeployConfig(activeSessionId, { appName: 'agent-hub-app', buildCommand: 'npm run build', startCommand: 'npm start' });
      await api.deployToPlatform(activeSessionId, { target: target as 'docker' | 'vercel' | 'cloudflare', production: target !== 'docker' });
    } catch (err: any) {
      console.error('[deploy] Failed:', err.message);
    }
  };

  return (
    <div className="border-t border-hub p-4">
      {tags.length > 0 && (
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {tags.map((tag) => (
            <span key={tag.agentId}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-hub-accent/10 border border-hub-accent/30 rounded-sm text-footnote text-hub-accent"
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
          className="flex-1 bg-hub-input text-hub-primary rounded-hub-lg px-4 py-3 resize-none focus:outline-none focus:ring-1 focus:ring-hub-accent text-body placeholder:text-hub-muted"
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
          className="text-footnote bg-hub-input text-hub-tertiary rounded-sm px-1.5 py-1 border border-hub focus:outline-none focus:ring-1 focus:ring-hub-accent cursor-pointer shrink-0"
          title="Orchestration mode: parallel runs all @mentioned agents at once, sequential runs them one after another"
        >
          <option value="parallel">∥</option>
          <option value="sequential">→</option>
        </select>

        <label className="flex items-center gap-1.5 text-footnote text-hub-tertiary cursor-pointer select-none shrink-0" title="When off, permission requests are sent to you for approval">
          <input
            type="checkbox"
            checked={trustMode}
            onChange={(e) => setTrustMode(e.target.checked)}
            className="rounded-sm border-hub bg-hub-input text-hub-accent focus:ring-hub-accent"
          />
          Trust
        </label>

        <input
          ref={fileRef}
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && activeSessionId) {
              // Attach file to workspace and notify in chat
              onSend(`[Attached: ${file.name}]`, tags, orchestrationMode);
            }
            // Reset so the same file can be re-selected
            if (fileRef.current) fileRef.current.value = '';
          }}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="p-3 text-hub-tertiary hover:text-hub-secondary rounded-md hover:bg-hub-hover transition"
          title="Attach file"
        >
          <Paperclip className="w-4 h-4" />
        </button>

        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="p-3 bg-hub-accent text-white rounded-md hover:bg-hub-accent-hover active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
