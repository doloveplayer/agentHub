import { useState, useMemo } from 'react';
import { User, Copy, Check, Quote, Loader2, AlertCircle, MoreHorizontal } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Message } from '@agenthub/shared';
import { agentColor } from './AgentMentionPopup';
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
  'code-agent': 'C',
  'review-agent': 'R',

};

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
    } catch { /* clipboard unavailable */ }
  };
  const color = isHuman ? undefined : agentColor(nameForKey);
  const components = useMemo(() => createMarkdownComponents(message.id, agentName), [message.id, agentName]);

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
        style={{ backgroundColor: isHuman ? 'var(--accent-primary)' : (color ?? 'var(--bg-raised)'), color: '#fff' }}
      >
        {isHuman ? <User className="w-4 h-4" /> : initial}
      </div>
      <div className={`${isHuman ? 'max-w-[72%] items-end' : 'max-w-[85%] items-start'}`}>
        <div className={`flex items-center gap-2 mb-1 ${isHuman ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs text-hub-tertiary font-medium">{label}</span>
          {time && <span className="text-[10px] text-hub-muted">{time}</span>}
          {/* Status indicators */}
          {!isHuman && message.status === 'queued' && (
            <span className="flex items-center gap-1 text-[10px] text-hub-warning">
              <Loader2 className="w-3 h-3 animate-spin" />
              Waiting in queue...
            </span>
          )}
          {!isHuman && message.status === 'streaming' && (
            <span className="flex items-center gap-1 text-[10px] text-hub-accent">
              <Loader2 className="w-3 h-3 animate-spin" />
              Agent is replying...
            </span>
          )}
          {isHuman && message.status === 'sending' && (
            <span className="flex items-center gap-1 text-[10px] text-hub-tertiary">
              <Loader2 className="w-3 h-3 animate-spin" />
              Sending...
            </span>
          )}
          {message.status === 'error' && (
            <span className="flex items-center gap-0.5 text-[10px] text-hub-danger" title="Error occurred">
              <AlertCircle className="w-3 h-3" />
              Error
            </span>
          )}
          {message.content && message.status === 'done' && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:bg-hub-hover"
              title="复制"
            >
              {copied ? <Check className="w-3 h-3 text-hub-success" /> : <Copy className="w-3 h-3 text-hub-tertiary" />}
            </button>
          )}
        </div>
        <div className={`rounded-hub-2xl px-4 py-2.5 text-sm leading-relaxed w-fit max-w-full ${
          isHuman
            ? message.status === 'error' ? 'bg-hub-accent border border-hub-danger/40 text-white rounded-tr-hub-md' : 'bg-hub-accent text-white rounded-tr-hub-md'
            : message.status === 'error' ? 'bg-hub-raised border border-hub-danger/40 text-hub-primary rounded-tl-hub-md' : 'bg-hub-raised border border-hub text-hub-primary rounded-tl-hub-md'
        }`}>
          {message.content ? (
            <div className="markdown-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                skipHtml
                urlTransform={(url) => safeMarkdownUrl(url)}
                components={components}
              >
                {safeContent(message.content)}
              </ReactMarkdown>
            </div>
          ) : isStreaming ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-4 rounded-full streaming-cursor" style={{ backgroundColor: 'var(--text-tertiary)' }} />
              <span className="w-1.5 h-3 rounded-full streaming-cursor" style={{ backgroundColor: 'var(--text-tertiary)', opacity: 0.6, animationDelay: '0.15s' }} />
              <span className="w-1.5 h-2 rounded-full streaming-cursor" style={{ backgroundColor: 'var(--text-tertiary)', opacity: 0.3, animationDelay: '0.3s' }} />
            </span>
          ) : message.status === 'error' ? (
            <span className="flex items-center gap-1 text-hub-danger text-xs">
              <AlertCircle className="w-3.5 h-3.5" />
              Agent encountered an error
            </span>
          ) : (
            <span className="text-hub-muted italic text-xs">[No output]</span>
          )}
        </div>
        {message.status === 'done' && !isHuman && (
          <InteractionHistory messageId={message.id} />
        )}
      </div>
    </div>
  );
}

function createMarkdownComponents(messageId?: string, agentName?: string): Components {
  return {
    a: ({ children, href, ...props }) => (
      <a href={href} target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    ),
    table: ({ children, ...props }) => (
      <div className="markdown-table-wrap">
        <table {...props}>{children}</table>
      </div>
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
                const payload: QuotePayload = {
                  text,
                  sourceType: 'message',
                  sourceMessageId: messageId,
                  agentName,
                };
                insertPrompt(buildQuotePrompt(payload));
              }}
              className="absolute right-0 top-0 hidden h-6 w-6 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover group-hover/paragraph:inline-flex"
              title="引用并交给 Agent"
            >
              <Quote className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      );
    },
    code: ({ inline, className, children, ...props }: any) => {
      const codeStr = childrenToText(children).replace(/\n$/, '');
      if (inline) {
        return (
          <code
            style={{ color: 'var(--accent-primary)', fontWeight: 500 }}
            {...props}
          >
            {codeStr}
          </code>
        );
      }
      const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
      return <FoldableCodeBlock language={language} code={codeStr} messageId={messageId} agentName={agentName} />;
    },
  };
}

function FoldableCodeBlock({ language, code, messageId, agentName }: { language: string; code: string; messageId?: string; agentName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = code.split('\n');
  const shouldFold = lines.length > 6;
  const displayLines = expanded || !shouldFold ? lines : lines.slice(0, 6);
  const displayCode = displayLines.join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="relative my-2 group/code">
      {/* Header: language label + actions */}
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-mono text-[10px] text-hub-muted">{language || 'code'}</span>
        <div className="flex items-center gap-1 opacity-0 group-hover/code:opacity-100 transition">
          <button
            onClick={() => {
              const payload: QuotePayload = {
                text: code,
                sourceType: 'message',
                sourceMessageId: messageId,
                agentName,
                contextMeta: { language },
              };
              insertPrompt(buildQuotePrompt(payload));
            }}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover"
            title="让 Agent 修改这段代码"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button
            onClick={handleCopy}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover"
            title="Copy"
          >
            {copied
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            }
          </button>
        </div>
      </div>
      {/* Code area: side border style */}
      <div className="border-l-2 border-hub-accent/40 pl-3">
        <pre className="text-[12px] leading-relaxed overflow-x-auto font-mono text-hub-primary m-0 p-0 bg-transparent">
          <code>{displayCode}</code>
        </pre>
      </div>
      {/* Fold toggle */}
      {shouldFold && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] text-hub-link hover:text-hub-accent transition"
        >
          {expanded ? '收起' : `展开全部 (${lines.length} 行)`}
        </button>
      )}
    </div>
  );
}

function insertPrompt(prompt: string): void {
  window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', { detail: { prompt } }));
}

function childrenToText(children: unknown): string {
  if (typeof children === 'string') return children.trim();
  if (Array.isArray(children)) return children.map(childrenToText).join('').trim();
  if (children && typeof children === 'object' && 'props' in children) {
    return childrenToText((children as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}
