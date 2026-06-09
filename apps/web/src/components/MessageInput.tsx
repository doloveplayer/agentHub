import { useEffect, useState, useRef, KeyboardEvent, useMemo } from 'react';
import { Send, Paperclip, Square } from 'lucide-react';
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
  onSend: (content: string, mentionedAgents: MentionTag[], mode?: 'parallel' | 'sequential', quoteReferenceId?: string | null, skillInvocation?: string | null) => void;
  disabled?: boolean;
  mentionableAgents?: AgentConfig[];
  streamingMessageIds?: string[];
  onStopAgent?: (agentMessageId: string) => void;
}

export function MessageInput({ onSend, disabled, mentionableAgents, streamingMessageIds, onStopAgent }: Props) {
  const agents = useAppStore((s) => s.agents);
  const sessions = useAppStore((s) => s.sessions);
  const orchestrationMode = useAppStore((s) => s.orchestrationMode);
  const setOrchestrationMode = useAppStore((s) => s.setOrchestrationMode);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeSessionType = useAppStore((s) => s.sessions.find((session: any) => session.id === s.activeSessionId)?.type);
  const addMessage = useAppStore((s) => s.addMessage);
  const messages = useAppStore((s) => s.messages);
  const recentMessages = (messages[activeSessionId ?? ''] ?? []).slice(-20).map(m => m.content).filter(Boolean);
  const myHistory = (messages[activeSessionId ?? ''] ?? []).filter((m: any) => m.senderType === 'human').map((m: any) => m.content);
  const [value, setValue] = useState('');
  const [historyIdx, setHistoryIdx] = useState(-1);
  const savedInput = useRef('');
  const [showPopup, setShowPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [tags, setTags] = useState<MentionTag[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [inputHeight, setInputHeight] = useState(96);
  const dragRef = useRef({ startY: 0, startH: 0 });
  const [slashQuery, setSlashQuery] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const pendingQuoteRef = useRef<PromptInsertDetail['quoteRef'] | null>(null);

  const matchSource = mentionableAgents ?? agents;
  const matchedAgents = recommendAgents(mentionQuery, matchSource, recentMessages);
  const isStreaming = (streamingMessageIds?.length ?? 0) > 0;

  const agentSkills = useMemo(() => {
    if (!activeSessionId) return [];
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return [];
    const agentIds = new Set((session.agents || []).map(sa => sa.agentId));
    const seen = new Set<string>();
    const result: { name: string; description: string }[] = [];
    for (const a of agents) {
      if (!agentIds.has(a.id)) continue;
      for (const s of (a.skills || [])) {
        if (!seen.has(s.name)) {
          seen.add(s.name);
          result.push({ name: s.name, description: s.description });
        }
      }
    }
    return result;
  }, [activeSessionId, sessions, agents]);

  const BUILTIN_SLASH_COMMANDS = ['/plan','/review','/fix','/deploy','/init','/test','/audit','/compact'];
  const allSlashCommands = useMemo(() => {
    const skills = agentSkills.map(s => '/' + s.name);
    return [...BUILTIN_SLASH_COMMANDS, ...skills];
  }, [agentSkills]);

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

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: inputHeight };
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
  };
  const handleResizeMove = (e: MouseEvent) => {
    const delta = dragRef.current.startY - e.clientY;
    setInputHeight(Math.max(60, Math.min(400, dragRef.current.startH + delta)));
  };
  const handleResizeEnd = () => {
    document.removeEventListener('mousemove', handleResizeMove);
    document.removeEventListener('mouseup', handleResizeEnd);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const pos = e.target.selectionStart ?? 0;
    if (historyIdx >= 0) { setHistoryIdx(-1); savedInput.current = ''; }
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
      const cmdCount = allSlashCommands.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => (i + 1) % cmdCount); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => (i - 1 + cmdCount) % cmdCount); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const filtered = slashQuery
          ? allSlashCommands.filter(c => c.startsWith(slashQuery))
          : allSlashCommands;
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

    // Up arrow → cycle backward through sent message history
    if (e.key === 'ArrowUp' && !showPopup && !showSlash) {
      e.preventDefault();
      if (myHistory.length === 0) return;
      if (historyIdx === -1) {
        savedInput.current = value;
        setHistoryIdx(myHistory.length - 1);
        setValue(myHistory[myHistory.length - 1]);
      } else if (historyIdx > 0) {
        setHistoryIdx(historyIdx - 1);
        setValue(myHistory[historyIdx - 1]);
      }
      return;
    }
    // Down arrow → cycle forward through history
    if (e.key === 'ArrowDown' && historyIdx >= 0 && !showPopup && !showSlash) {
      e.preventDefault();
      if (historyIdx < myHistory.length - 1) {
        setHistoryIdx(historyIdx + 1);
        setValue(myHistory[historyIdx + 1]);
      } else {
        setHistoryIdx(-1);
        setValue(savedInput.current);
        savedInput.current = '';
      }
      return;
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
      setHistoryIdx(-1);
      savedInput.current = '';
      ref.current?.focus();
      return;
    }

    let skillInvocation: string | null = null;
    let finalValue = trimmed;
    const slashMatch = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/);
    if (slashMatch) {
      const cmd = slashMatch[1].toLowerCase();
      const rest = slashMatch[2] || '';
      if (agentSkills.some(s => s.name === cmd)) {
        skillInvocation = cmd;
        finalValue = rest || `Run ${cmd}`;
      }
    }

    onSend(finalValue, tags, orchestrationMode, quoteReferenceId, skillInvocation);

    // Touch session updatedAt locally for immediate sort feedback
    if (activeSessionId) {
      useAppStore.getState().updateSessionInList(activeSessionId, { updatedAt: new Date().toISOString() });
    }

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
    <div className="border-t border-hub bg-hub-root flex flex-col" style={{ height: inputHeight }}>
      {/* Drag handle */}
      <div className="flex-shrink-0 cursor-ns-resize group h-0.5 hover:bg-hub-accent/60 active:bg-hub-accent transition-colors" onMouseDown={handleResizeStart} title="拖拽调整输入区高度" />
      <div className="px-4 py-3 flex-1 flex flex-col min-h-0">
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

      <div className="relative flex gap-2 items-end flex-1 min-h-0">
        <textarea
          ref={ref}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... @ to mention an agent"
          className="flex-1 bg-hub-surface border border-hub-border text-hub-primary rounded-2xl px-4 py-3 focus:outline-none focus:ring-1 focus:ring-hub-accent text-body placeholder:text-hub-muted resize-none self-stretch"
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
            agentSkills={agentSkills}
          />
        )}

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
          onClick={() => setOrchestrationMode(orchestrationMode === 'parallel' ? 'sequential' : 'parallel')}
          className={`p-2.5 rounded-md hover:bg-hub-hover transition shrink-0 ${
            orchestrationMode === 'parallel' ? 'text-hub-accent' : 'text-hub-warning'
          }`}
          title={orchestrationMode === 'parallel' ? '并行模式：@ 多个 agent 同时运行，点击切换串行' : '串行模式：@ 多个 agent 逐个运行，点击切换并行'}
        >
          <span className="text-sm font-bold">{orchestrationMode === 'parallel' ? '∥' : '→'}</span>
        </button>

        {isStreaming && onStopAgent ? (
          <button
            onClick={() => {
              const ids = streamingMessageIds ?? [];
              ids.forEach((id) => onStopAgent(id));
            }}
            className="p-3 bg-[oklch(0.88_0.003_95)] text-hub-primary rounded-md hover:bg-[oklch(0.83_0.003_95)] active:scale-[0.97] transition flex items-center gap-1.5"
            title="Stop generation"
          >
            <Square className="w-4 h-4 text-hub-accent" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            className="p-3 bg-hub-accent text-white rounded-md hover:bg-hub-accent-hover active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
