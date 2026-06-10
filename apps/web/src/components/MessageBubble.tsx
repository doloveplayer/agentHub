import { useState, useMemo } from 'react';
import { User, Copy, Check, Quote, Loader2, AlertCircle, ChevronDown, ChevronRight, Brain, Wrench, FileCode, Terminal } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Message } from '@agenthub/shared';
import { agentAvatarColor } from './AgentCard';
import { safeMarkdownUrl } from '../lib/markdown';
import { safeContent } from '../lib/text';
import { buildQuotePrompt, type QuotePayload } from '../lib/quoteContext';
import { InteractionHistory } from './InteractionHistory';

interface Props {
  message: Message;
  isStreaming?: boolean;
  agentDisplayName?: string;
  agentName?: string;
}

const AGENT_ICONS: Record<string, string> = {
  'code-agent': 'C', 'review-agent': 'R',
};

/* ---- Content Block Types ---- */
type Block =
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; tool: string; input: string }
  | { type: 'tool_result'; content: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'text'; content: string };

function parseContentBlocks(content: string): Block[] {
  const blocks: Block[] = [];

  // Split out AGENTHUB_PLAN comments into thinking blocks
  const cleaned = content.replace(/<!--AGENTHUB_PLAN[\s\S]*?-->/g, (match) => {
    const inner = match.slice(19, -3).trim();
    if (inner.length > 5) {
      blocks.push({ type: 'thinking', content: '📋 AgentHub Plan\n' + inner.slice(0, 500) + (inner.length > 500 ? '...' : '') });
    }
    return '';
  });

  // Split by code fences
  const parts = cleaned.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (!part.trim()) continue;
    const codeMatch = part.match(/^```(\w*)\n([\s\S]*?)```$/);
    if (codeMatch) {
      blocks.push({ type: 'code', language: codeMatch[1] || '', code: codeMatch[2].trimEnd() });
    } else {
      // Check for tool_use markers (agent might not use these, but handle for future)
      const trimmed = part.trim();
      if (trimmed) {
        blocks.push({ type: 'text', content: trimmed });
      }
    }
  }

  return blocks;
}

export function MessageBubble({ message, isStreaming, agentDisplayName, agentName }: Props) {
  const [copied, setCopied] = useState(false);
  const isHuman = message.senderType === 'human';
  const nameForKey = agentName || message.agentId || 'agent';

  const handleCopy = async () => {
    const text = safeContent(message.content);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* clipboard unavailable */ }
    }
  };

  const color = isHuman ? undefined : agentAvatarColor(nameForKey);
  const components = useMemo(() => createMarkdownComponents(message.id, agentName), [message.id, agentName]);
  const label = isHuman ? 'You' : (agentDisplayName || 'Agent');
  const initial = isHuman ? 'U' : (AGENT_ICONS[nameForKey] || (agentDisplayName?.charAt(0) ?? 'A'));
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  const rawContent = safeContent(message.content);
  const blocks = rawContent ? parseContentBlocks(rawContent) : [];

  return (
    <div className={`flex gap-3 px-4 py-2.5 group animate-fade-in-up ${isHuman ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-xs font-semibold shadow-sm"
        style={{ backgroundColor: isHuman ? 'var(--accent-primary)' : (color ?? 'var(--bg-raised)'), color: '#fff' }}
      >
        {isHuman ? <User className="w-4 h-4" /> : initial}
      </div>

      <div className={`${isHuman ? 'max-w-[72%] items-end' : 'max-w-[85%] items-start'}`}>
        {/* Label row */}
        <div className={`flex items-center gap-2 mb-1 ${isHuman ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs text-hub-tertiary font-medium">{label}</span>
          {time && <span className="text-[10px] text-hub-muted">{time}</span>}
          {!isHuman && message.status === 'queued' && (
            <span className="flex items-center gap-1 text-[10px] text-hub-warning"><Loader2 className="w-3 h-3 animate-spin" />Queued...</span>
          )}
          {!isHuman && message.status === 'streaming' && (
            <span className="flex items-center gap-1 text-[10px] text-hub-accent"><Loader2 className="w-3 h-3 animate-spin" />Replying...</span>
          )}
          {isHuman && message.status === 'sending' && (
            <span className="flex items-center gap-1 text-[10px] text-hub-tertiary"><Loader2 className="w-3 h-3 animate-spin" />Sending...</span>
          )}
          {message.status === 'error' && (
            <span className="flex items-center gap-0.5 text-[10px] text-hub-danger" title="Error"><AlertCircle className="w-3 h-3" />Error</span>
          )}
          {message.content && message.status === 'done' && (
            <button onClick={handleCopy} className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:bg-hub-hover" title="Copy">
              {copied ? <Check className="w-3 h-3 text-hub-success" /> : <Copy className="w-3 h-3 text-hub-tertiary" />}
            </button>
          )}
        </div>

        {/* Content */}
        <div className={`rounded-hub-2xl px-4 py-2.5 text-sm leading-relaxed w-fit max-w-full ${
          isHuman
            ? message.status === 'error' ? 'bg-hub-sidebar border-2 border-hub-danger/40 text-hub-primary rounded-tr-hub-md' : 'bg-hub-sidebar border border-hub text-hub-primary rounded-tr-hub-md'
            : message.status === 'error' ? 'bg-hub-sidebar border-2 border-hub-danger/40 text-hub-primary rounded-tl-hub-md' : 'bg-hub-sidebar border border-hub text-hub-primary rounded-tl-hub-md'
        }`}>
          {message.content ? (
            blocks.length > 0 ? (
              <div className="space-y-3">
                {blocks.map((block, i) => (
                  <ContentBlock key={i} block={block} components={components} messageId={message.id} agentName={agentName} />
                ))}
              </div>
            ) : (
              <div className="markdown-content">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                  skipHtml
                  urlTransform={(url) => safeMarkdownUrl(url)}
                  components={components}
                >
                  {rawContent}
                </ReactMarkdown>
              </div>
            )
          ) : isStreaming ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-4 rounded-full streaming-cursor" style={{ backgroundColor: 'var(--text-tertiary)' }} />
              <span className="w-1.5 h-3 rounded-full streaming-cursor" style={{ backgroundColor: 'var(--text-tertiary)', opacity: 0.6, animationDelay: '0.15s' }} />
              <span className="w-1.5 h-2 rounded-full streaming-cursor" style={{ backgroundColor: 'var(--text-tertiary)', opacity: 0.3, animationDelay: '0.3s' }} />
            </span>
          ) : message.status === 'error' ? (
            <span className="flex items-center gap-1 text-hub-danger text-xs"><AlertCircle className="w-3.5 h-3.5" />Agent encountered an error</span>
          ) : (
            <span className="text-hub-muted italic text-xs">[No output]</span>
          )}
        </div>

        {/* Token summary — show when done */}
        {message.status === 'done' && !isHuman && (message.inputTokens || message.outputTokens) ? (
          <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-hub-muted">
            {message.inputTokens ? <span>📥 {formatTokens(message.inputTokens)}</span> : null}
            {message.outputTokens ? <span>📤 {formatTokens(message.outputTokens)}</span> : null}
          </div>
        ) : null}

        {message.status === 'done' && !isHuman && (
          <InteractionHistory messageId={message.id} />
        )}
      </div>
    </div>
  );
}

/* ---- Content Block Renderer ---- */
function ContentBlock({ block, components, messageId, agentName }: {
  block: Block; components: Components; messageId?: string; agentName?: string;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} />;
    case 'code':
      return <FoldableCodeBlock language={block.language} code={block.code} messageId={messageId} agentName={agentName} />;
    case 'text':
      return (
        <div className="markdown-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            skipHtml
            urlTransform={(url) => safeMarkdownUrl(url)}
            components={components}
          >
            {block.content}
          </ReactMarkdown>
        </div>
      );
    default:
      return null;
  }
}

/* ---- Thinking Collapsible Block ---- */
function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-hub bg-hub-surface/50 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-hub-tertiary hover:bg-hub-hover/50 transition"
      >
        <Brain className="w-3.5 h-3.5 text-purple-400" />
        <span className="flex-1 text-left font-medium">Thinking</span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="px-3 py-2 border-t border-hub text-xs text-hub-secondary whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
}

/* ---- Markdown Components ---- */
function createMarkdownComponents(messageId?: string, agentName?: string): Components {
  return {
    a: ({ children, href, ...props }) => (
      <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>
    ),
    table: ({ children, ...props }) => (
      <div className="markdown-table-wrap"><table {...props}>{children}</table></div>
    ),
    img: ({ alt, src, ...props }) => (
      <img alt={alt ?? ''} src={src ?? ''} loading="lazy" {...props} />
    ),
    p: ({ children }) => {
      const text = childrenToText(children);
      return (
        <div className="group/paragraph relative pr-7">
          {children}
          {text && (
            <button
              onClick={() => {
                const payload: QuotePayload = { text, sourceType: 'message', sourceMessageId: messageId, agentName };
                insertPrompt(buildQuotePrompt(payload), {
                  sourceMessageId: messageId, selectionText: text, sourceType: 'message', contextMeta: { agentName },
                });
              }}
              className="absolute right-0 top-0 hidden h-6 w-6 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover group-hover/paragraph:inline-flex"
              title="Quote"
            ><Quote className="h-3.5 w-3.5" /></button>
          )}
        </div>
      );
    },
    code: ({ inline, className, children, ...props }: any) => {
      const codeStr = childrenToText(children).replace(/\n$/, '');
      if (inline) {
        return <code style={{ color: 'var(--accent-primary)', fontWeight: 500 }} {...props}>{codeStr}</code>;
      }
      const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
      return <FoldableCodeBlock language={language} code={codeStr} messageId={messageId} agentName={agentName} />;
    },
  };
}

function FoldableCodeBlock({ language, code, messageId, agentName }: {
  language: string; code: string; messageId?: string; agentName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = code.split('\n');
  const shouldFold = lines.length > 8;
  const displayLines = expanded || !shouldFold ? lines : lines.slice(0, 8);
  const displayCode = displayLines.join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className="relative my-1 group/code">
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-mono text-[10px] text-hub-muted flex items-center gap-1">
          <FileCode className="w-3 h-3" />{language || 'code'}
        </span>
        <div className="flex items-center gap-1 opacity-0 group-hover/code:opacity-100 transition">
          <button onClick={() => {
            const payload: QuotePayload = { text: code, sourceType: 'message', sourceMessageId: messageId, agentName, contextMeta: { language } };
            insertPrompt(buildQuotePrompt(payload), { sourceMessageId: messageId, selectionText: code, sourceType: 'message', contextMeta: { language, agentName } });
          }} className="inline-flex h-5 w-5 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover" title="Edit code">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button onClick={handleCopy} className="inline-flex h-5 w-5 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover" title="Copy">
            {copied ? <Check className="w-3 h-3 text-hub-success" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>
      <div className="border-l-2 border-hub-accent/40 pl-3">
        <pre className="text-[12px] leading-relaxed overflow-x-auto font-mono text-hub-primary m-0 p-0 bg-transparent">
          <code>{displayCode}</code>
        </pre>
      </div>
      {shouldFold && (
        <button onClick={() => setExpanded(!expanded)} className="mt-1 text-[11px] text-hub-link hover:text-hub-accent transition">
          {expanded ? 'Collapse' : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

function insertPrompt(prompt: string, quoteRef?: { sourceMessageId?: string; selectionText: string; sourceType: string; contextMeta?: Record<string, unknown> }): void {
  window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', { detail: { prompt, quoteRef } }));
}

function childrenToText(children: unknown): string {
  if (typeof children === 'string') return children.trim();
  if (Array.isArray(children)) return children.map(childrenToText).join('').trim();
  if (children && typeof children === 'object' && 'props' in children) {
    return childrenToText((children as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k tokens';
  return n + ' tokens';
}
