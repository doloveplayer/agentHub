import { useState } from 'react';
import { User, Copy, Check, Quote, Wand2 } from 'lucide-react';
import Editor from '@monaco-editor/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Message } from '@agenthub/shared';
import { agentColor } from './AgentMentionPopup';
import { safeMarkdownUrl } from '../lib/markdown';

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
        style={{ backgroundColor: isHuman ? 'var(--accent-primary)' : (color ?? 'var(--bg-raised)'), color: '#fff' }}
      >
        {isHuman ? <User className="w-4 h-4" /> : initial}
      </div>
      <div className={`max-w-[72%] ${isHuman ? 'items-end' : 'items-start'}`}>
        <div className={`flex items-center gap-2 mb-1 ${isHuman ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs text-hub-tertiary font-medium">{label}</span>
          {time && <span className="text-[10px] text-hub-muted">{time}</span>}
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
        <div className={`rounded-hub-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isHuman
            ? 'bg-hub-accent text-white rounded-tr-hub-md'
            : 'bg-hub-raised border border-hub text-hub-primary rounded-tl-hub-md'
        }`}>
          {message.content ? (
            <div className="markdown-content">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                skipHtml
                urlTransform={(url) => safeMarkdownUrl(url)}
                components={markdownComponents}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          ) : isStreaming ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-4 bg-hub-tertiary rounded-full streaming-cursor" />
              <span className="w-1.5 h-3 bg-hub-tertiary/60 rounded-full streaming-cursor" style={{ animationDelay: '0.15s' }} />
              <span className="w-1.5 h-2 bg-hub-tertiary/30 rounded-full streaming-cursor" style={{ animationDelay: '0.3s' }} />
            </span>
          ) : (
            <span className="text-hub-muted italic text-xs">{message.status === 'error' ? '[Agent stopped]' : '[No output]'}</span>
          )}
        </div>
      </div>
    </div>
  );
}

const markdownComponents: Components = {
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
      <p className="group/paragraph relative pr-7">
        {children}
        {text && (
          <button
            onClick={() => insertPrompt(`请基于以下引用继续处理：\n\n> ${text.replace(/\n/g, '\n> ')}`)}
            className="absolute right-0 top-0 hidden h-6 w-6 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover group-hover/paragraph:inline-flex"
            title="引用并交给 Agent"
          >
            <Quote className="h-3.5 w-3.5" />
          </button>
        )}
      </p>
    );
  },
  code: ({ inline, className, children, ...props }: any) => {
    const code = String(children ?? '').replace(/\n$/, '');
    const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? 'plaintext';
    if (inline) return <code className={className} {...props}>{children}</code>;
    return <InlineCodeEditor code={code} language={language} />;
  },
};

function InlineCodeEditor({ code, language }: { code: string; language: string }) {
  const [value, setValue] = useState(code);
  const height = Math.min(420, Math.max(120, code.split('\n').length * 20 + 44));
  return (
    <div className="my-3 overflow-hidden rounded-md border border-hub bg-hub-code">
      <div className="flex items-center justify-between border-b border-hub px-3 py-1.5">
        <span className="font-mono text-[11px] text-hub-tertiary">{language}</span>
        <button
          onClick={() => insertPrompt(`请修改并应用这段代码：\n\n\`\`\`${language}\n${value}\n\`\`\``)}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover"
          title="让 Agent 修改这段代码"
        >
          <Wand2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <Editor
        height={`${height}px`}
        language={language}
        value={value}
        theme="vs-dark"
        onChange={(next) => setValue(next ?? '')}
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fontSize: 12,
          lineNumbersMinChars: 3,
        }}
      />
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
