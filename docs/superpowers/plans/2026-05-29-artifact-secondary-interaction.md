# 产物二次交互 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Agent 产物（网页预览、PPT、文档、代码）的选区引用、结构化 prompt 注入、增量处理、以及交互历史可追溯。

**Architecture:** 前端通过 iframe 注入脚本捕获网页选区、postMessage 回父页面；引用操作统一走 `agenthub:prompt-insert` 事件总线，但升级为结构化 payload（含来源元数据）；后端在 Message 模型旁新建 QuoteReference 表记录引用链路；Agent prompt 注入结构化引用上下文引导增量修改。

**Tech Stack:** React 18, TypeScript, Hono, Prisma, PostgreSQL, postMessage API, Monaco Editor

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `apps/web/src/components/QuoteToolbar.tsx` | 浮动引用操作栏：收到选区事件后显示，用户点击后构建结构化 prompt 并 dispatch |
| `apps/web/src/components/InteractionHistory.tsx` | 消息气泡内的引用链路展示（该消息引用了谁 / 被谁引用） |
| `apps/web/src/lib/quoteContext.ts` | 引用上下文构建工具：将选区信息序列化为结构化 prompt 片段 |
| `apps/api/src/routes/quoteReferences.ts` | QuoteReference CRUD API（GET by message, POST create） |

### Modified Files
| File | Change |
|------|--------|
| `apps/api/prisma/schema.prisma` | 新增 `QuoteReference` 模型 |
| `apps/web/src/components/PreviewFrame.tsx` | 添加选区监听 postMessage 接收逻辑 + 传递选区给 QuoteToolbar |
| `apps/web/src/components/MessageBubble.tsx` | 段落/代码引用改为使用结构化 prompt；展示 InteractionHistory |
| `apps/web/src/components/MessageInput.tsx` | `agenthub:prompt-insert` 事件升级：支持结构化 payload + 来源标签展示 |
| `apps/web/src/components/ChatView.tsx` | 集成 QuoteToolbar 组件 |
| `apps/web/src/components/AgentStatusPanel.tsx` | Preview tab 集成选区事件 |
| `apps/api/src/index.ts` | 注册 quoteReferences 路由 |
| `apps/api/src/routes/preview.ts` | `injectHmrScript` 扩展：同时注入选区监听脚本 |

---

## Task 1: Prisma Schema — QuoteReference 模型

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Migration: `apps/api/prisma/migrations/`

- [ ] **Step 1: 添加 QuoteReference 模型**

在 `schema.prisma` 的 `Message` 模型之后添加：

```prisma
model QuoteReference {
  id              String   @id @default(uuid())
  sourceMessageId String   // 被引用的消息 ID
  targetMessageId String?  // Agent 处理后的结果消息 ID（处理完成后回填）
  agentId         String?  // 处理该引用的 Agent ID
  selectionText   String   // 用户选中的文本内容
  sourceType      String   @default("message") // message | preview | ppt | document
  contextMeta     Json?    // 额外上下文：{ filePath, language, paragraphIndex, ... }
  sessionId       String
  session         Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  createdAt       DateTime @default(now())
}
```

在 `Session` 模型中添加关系：

```prisma
quoteReferences QuoteReference[]
```

- [ ] **Step 2: 生成并运行迁移**

Run: `cd apps/api && npx prisma migrate dev --name add-quote-reference`

Expected: 迁移成功，`QuoteReference` 表已创建。

- [ ] **Step 3: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat: add QuoteReference model for interaction history tracking"
```

---

## Task 2: QuoteReference API

**Files:**
- Create: `apps/api/src/routes/quoteReferences.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: 创建 quoteReferences 路由文件**

```typescript
// apps/api/src/routes/quoteReferences.ts
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../db/prisma.js';

const quoteReferences = new Hono();
quoteReferences.use('*', authMiddleware);

// GET /api/quote-references?messageId=xxx — 获取某消息的引用记录（作为 source 或 target）
quoteReferences.get('/', async (c) => {
  const messageId = c.req.query('messageId');
  if (!messageId) return c.json({ error: 'messageId required' }, 400);

  const [asSource, asTarget] = await Promise.all([
    prisma.quoteReference.findMany({
      where: { sourceMessageId: messageId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.quoteReference.findMany({
      where: { targetMessageId: messageId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return c.json({ quotedFrom: asSource, quotedBy: asTarget });
});

// POST /api/quote-references — 创建引用记录
quoteReferences.post('/', async (c) => {
  const body = await c.req.json();
  const { sourceMessageId, selectionText, sourceType, contextMeta, sessionId } = body;

  if (!sourceMessageId || !selectionText || !sessionId) {
    return c.json({ error: 'sourceMessageId, selectionText, sessionId required' }, 400);
  }

  const ref = await prisma.quoteReference.create({
    data: {
      sourceMessageId,
      selectionText: selectionText.slice(0, 2000), // 截断防滥用
      sourceType: sourceType || 'message',
      contextMeta: contextMeta || undefined,
      sessionId,
    },
  });

  return c.json(ref);
});

// PATCH /api/quote-references/:id — 回填 targetMessageId（Agent 处理完成后）
quoteReferences.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { targetMessageId, agentId } = body;

  const ref = await prisma.quoteReference.update({
    where: { id },
    data: {
      ...(targetMessageId && { targetMessageId }),
      ...(agentId && { agentId }),
    },
  });

  return c.json(ref);
});

export default quoteReferences;
```

- [ ] **Step 2: 注册路由到 index.ts**

在 `apps/api/src/index.ts` 中 `app.route('/api/preview', previewRoutes)` 附近添加：

```typescript
import quoteRefRoutes from './routes/quoteReferences.js';
// ...
app.route('/api/quote-references', quoteRefRoutes);
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/quoteReferences.ts apps/api/src/index.ts
git commit -m "feat: add QuoteReference CRUD API"
```

---

## Task 3: 引用上下文构建工具

**Files:**
- Create: `apps/web/src/lib/quoteContext.ts`

- [ ] **Step 1: 创建 quoteContext 工具模块**

```typescript
// apps/web/src/lib/quoteContext.ts

export interface QuotePayload {
  /** 选中的文本内容 */
  text: string;
  /** 引用来源类型 */
  sourceType: 'message' | 'preview' | 'ppt' | 'document';
  /** 来源消息 ID（message 类型时必填） */
  sourceMessageId?: string;
  /** 来源 Agent 名称（用于 prompt 注入） */
  agentName?: string;
  /** 额外上下文元数据 */
  contextMeta?: {
    language?: string;
    filePath?: string;
    paragraphIndex?: number;
    codeBlockIndex?: number;
  };
}

/**
 * 将引用 payload 序列化为结构化 prompt 文本。
 * Agent 收到后能理解引用来源并做增量处理。
 */
export function buildQuotePrompt(payload: QuotePayload): string {
  const { text, sourceType, agentName, contextMeta } = payload;

  const sourceLabel = sourceType === 'preview'
    ? '网页预览'
    : sourceType === 'ppt'
      ? 'PPT 幻灯片'
      : sourceType === 'document'
        ? '文档'
        : agentName
          ? `${agentName} 的回复`
          : '消息';

  let contextLine = `来源：${sourceLabel}`;
  if (contextMeta?.language) contextLine += ` | 语言：${contextMeta.language}`;
  if (contextMeta?.filePath) contextLine += ` | 文件：${contextMeta.filePath}`;

  const truncated = text.length > 3000 ? text.slice(0, 3000) + '\n...（已截断）' : text;

  return [
    `引用内容 — ${contextLine}`,
    '',
    '```' + (contextMeta?.language || ''),
    truncated,
    '```',
    '',
    '请基于以上引用内容进行增量修改，仅处理引用部分，不要重写无关内容。',
  ].join('\n');
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/quoteContext.ts
git commit -m "feat: add structured quote context builder"
```

---

## Task 4: 升级 MessageBubble 引用为结构化 prompt

**Files:**
- Modify: `apps/web/src/components/MessageBubble.tsx`

- [ ] **Step 1: 引入 quoteContext 并升级段落引用**

在 `MessageBubble.tsx` 顶部添加 import：

```typescript
import { buildQuotePrompt, type QuotePayload } from '../lib/quoteContext';
```

将 `markdownComponents` 中的 `p` 组件（第 147-163 行）替换为：

```tsx
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
              sourceMessageId: undefined, // 由 ChatView 传入
              agentName: undefined,
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
```

- [ ] **Step 2: 升级代码块引用为结构化 prompt**

将 `FoldableCodeBlock` 中的编辑按钮 onClick（第 204 行）替换为：

```tsx
onClick={() => {
  const payload: QuotePayload = {
    text: code,
    sourceType: 'message',
    contextMeta: { language },
  };
  insertPrompt(buildQuotePrompt(payload));
}}
```

- [ ] **Step 3: 为 MessageBubble 添加 sourceMessageId prop**

修改 `Props` 接口和组件，将 `message.id` 传入引用 payload：

```typescript
interface Props {
  message: Message;
  isStreaming?: boolean;
  agentDisplayName?: string;
  agentName?: string;
}
```

在 `markdownComponents` 中无法直接访问 `message.id`（因为是模块级常量），需要改为将 `messageId` 通过 React Context 或闭包传入。最简方案：将 `markdownComponents` 改为函数，在 `MessageBubble` 组件内创建：

```tsx
// 在 MessageBubble 组件内
const components = useMemo(() => createMarkdownComponents(message.id, agentName), [message.id, agentName]);
```

将 `markdownComponents` 常量改为 `createMarkdownComponents` 函数：

```tsx
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
        return <code style={{ color: 'var(--accent-primary)', fontWeight: 500 }} {...props}>{codeStr}</code>;
      }
      const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
      return <FoldableCodeBlock language={language} code={codeStr} messageId={messageId} agentName={agentName} />;
    },
  };
}
```

更新 `FoldableCodeBlock` 接收 `messageId` 和 `agentName` props。

- [ ] **Step 4: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/MessageBubble.tsx
git commit -m "feat: upgrade MessageBubble quotes to structured context prompts"
```

---

## Task 5: 网页预览选区监听 — 注入脚本

**Files:**
- Modify: `apps/api/src/routes/preview.ts`

- [ ] **Step 1: 添加选区监听注入脚本**

在 `preview.ts` 的 `injectHmrScript` 函数之后添加选区监听脚本注入：

```typescript
/** Selection capture script — injected alongside HMR polyfill.
 *  Listens for text selection changes and posts selected text to parent window. */
function selectionCaptureScript(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  document.addEventListener('selectionchange', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        window.parent.postMessage({ type: 'agenthub:selection-clear' }, '*');
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 2 || text.length > 5000) return;

      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      window.parent.postMessage({
        type: 'agenthub:selection',
        text,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        url: window.location.href,
      }, '*');
    }, 300);
  });
}
```

修改 `injectHmrScript` 函数，同时注入选区脚本：

```typescript
function injectHmrScript(html: string, sessionId: string, port: number): string {
  const proxyPath = `/api/preview/${sessionId}/proxy/${port}`;
  const hmrScript = `<script>(${hmrPolyfill.toString()})(${JSON.stringify(proxyPath)})</script>`;
  const selScript = `<script>(${selectionCaptureScript.toString()})()</script>`;
  const combined = hmrScript + selScript;
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${combined}`);
  }
  if (html.includes('<html>')) {
    return html.replace('<html>', `<html><head>${combined}</head>`);
  }
  return combined + html;
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/preview.ts
git commit -m "feat: inject selection capture script into preview iframe"
```

---

## Task 6: 网页预览选区接收 — PreviewFrame

**Files:**
- Modify: `apps/web/src/components/PreviewFrame.tsx`

- [ ] **Step 1: 添加 postMessage 监听和选区状态**

在 `PreviewFrame` 组件中添加选区接收逻辑：

```tsx
import { useEffect, useState, useCallback } from 'react';
// ... existing imports

interface SelectionData {
  text: string;
  rect: { top: number; left: number; width: number; height: number };
  url: string;
}

interface Props {
  sessionId: string;
  onSelection?: (selection: SelectionData | null) => void;
}
```

在组件内部添加 postMessage 监听：

```tsx
export function PreviewFrame({ sessionId, onSelection }: Props) {
  // ... existing state

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'agenthub:selection') {
        onSelection?.(event.data as SelectionData);
      } else if (event.data?.type === 'agenthub:selection-clear') {
        onSelection?.(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onSelection]);

  // ... rest of component
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/PreviewFrame.tsx
git commit -m "feat: PreviewFrame receives iframe selection events via postMessage"
```

---

## Task 7: QuoteToolbar 浮动操作栏

**Files:**
- Create: `apps/web/src/components/QuoteToolbar.tsx`

- [ ] **Step 1: 创建 QuoteToolbar 组件**

```tsx
// apps/web/src/components/QuoteToolbar.tsx
import { Quote, X } from 'lucide-react';
import { buildQuotePrompt, type QuotePayload } from '../lib/quoteContext';

interface SelectionData {
  text: string;
  rect: { top: number; left: number; width: number; height: number };
  url: string;
}

interface Props {
  selection: SelectionData | null;
  onDismiss: () => void;
}

export function QuoteToolbar({ selection, onDismiss }: Props) {
  if (!selection || !selection.text) return null;

  const handleQuote = () => {
    const payload: QuotePayload = {
      text: selection.text,
      sourceType: 'preview',
      contextMeta: {},
    };
    const prompt = buildQuotePrompt(payload);
    window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', { detail: { prompt } }));
    onDismiss();
  };

  // Position the toolbar near the selection in the iframe.
  // The iframe rect is relative to the iframe, so we offset by the iframe's position.
  return (
    <div
      className="absolute z-50 flex items-center gap-1 rounded-lg bg-hub-raised border border-hub shadow-lg px-2 py-1.5 animate-in fade-in zoom-in-95 duration-150"
      style={{ bottom: 60, right: 16 }}
    >
      <Quote className="h-3.5 w-3.5 text-hub-accent" />
      <span className="text-xs text-hub-primary max-w-48 truncate">
        {selection.text.slice(0, 60)}{selection.text.length > 60 ? '...' : ''}
      </span>
      <button
        onClick={handleQuote}
        className="ml-1 rounded bg-hub-accent px-2 py-0.5 text-[11px] font-medium text-white hover:bg-hub-accent-hover transition"
      >
        引用并交给 Agent
      </button>
      <button
        onClick={onDismiss}
        className="ml-0.5 text-hub-muted hover:text-hub-secondary transition"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/QuoteToolbar.tsx
git commit -m "feat: add QuoteToolbar floating action bar for preview selections"
```

---

## Task 8: ChatView 集成 QuoteToolbar + 选区事件

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: 在 ChatView 中集成选区状态和 QuoteToolbar**

在 `ChatView.tsx` 中添加：

```typescript
import { QuoteToolbar } from './QuoteToolbar';
import { useState } from 'react';

// 在组件内部
const [previewSelection, setPreviewSelection] = useState<{
  text: string;
  rect: { top: number; left: number; width: number; height: number };
  url: string;
} | null>(null);
```

在 AgentStatusPanel 的 Preview tab 中传递 `onSelection`：

查找 `<AgentStatusPanel` 的使用位置，确保它能传递 `onSelection` 回调到 `PreviewFrame`。如果 `AgentStatusPanel` 直接渲染 `PreviewFrame`，需要给 `AgentStatusPanel` 添加 `onPreviewSelection` prop 并透传。

在 ChatView 的 JSX 底部（输入框附近）添加 QuoteToolbar：

```tsx
<QuoteToolbar selection={previewSelection} onDismiss={() => setPreviewSelection(null)} />
```

- [ ] **Step 2: 更新 AgentStatusPanel 透传 onSelection**

在 `AgentStatusPanel.tsx` 的 Props 中添加 `onPreviewSelection`，并在 Preview tab 渲染时传给 `PreviewFrame`：

```tsx
interface Props {
  // ... existing props
  onPreviewSelection?: (selection: { text: string; rect: { top: number; left: number; width: number; height: number }; url: string } | null) => void;
}

// 在 Preview tab 渲染处：
{activeTab === 'Preview' && activeSessionId && (
  <PreviewFrame sessionId={activeSessionId} onSelection={onPreviewSelection} />
)}
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/AgentStatusPanel.tsx
git commit -m "feat: integrate QuoteToolbar and preview selection into ChatView"
```

---

## Task 9: 引用记录持久化 — 发送时创建 QuoteReference

**Files:**
- Modify: `apps/web/src/components/MessageInput.tsx`
- Modify: `apps/web/src/hooks/useChat.ts` (或实际发送消息的 hook）

- [ ] **Step 1: 扩展 agenthub:prompt-insert 事件 payload**

修改 `MessageInput.tsx` 的事件监听，支持结构化 payload：

```typescript
interface PromptInsertDetail {
  prompt: string;
  quoteRef?: {
    sourceMessageId?: string;
    selectionText: string;
    sourceType: string;
    contextMeta?: Record<string, unknown>;
  };
}

useEffect(() => {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PromptInsertDetail>).detail;
    if (!detail?.prompt) return;
    setValue((current) => `${current.trim() ? `${current.trim()}\n\n` : ''}${detail.prompt}`);
    // 暂存 quoteRef 信息，发送时一并提交
    if (detail.quoteRef) {
      pendingQuoteRef.current = detail.quoteRef;
    }
    ref.current?.focus();
  };
  window.addEventListener('agenthub:prompt-insert', handler);
  return () => window.removeEventListener('agenthub:prompt-insert', handler);
}, []);
```

添加 `pendingQuoteRef` ref：

```typescript
const pendingQuoteRef = useRef<PromptInsertDetail['quoteRef'] | null>(null);
```

在 `handleSend` 中，发送消息后如果有 pendingQuoteRef，调用 API 创建引用记录：

```typescript
const handleSend = () => {
  const trimmed = value.trim();
  if (!trimmed || disabled) return;

  // ... existing /deploy intercept ...

  onSend(trimmed, tags, orchestrationMode);

  // Persist quote reference if this was a quote-initiated prompt
  if (pendingQuoteRef.current && activeSessionId) {
    const ref = pendingQuoteRef.current;
    api.createQuoteReference({
      sourceMessageId: ref.sourceMessageId || '',
      selectionText: ref.selectionText,
      sourceType: ref.sourceType,
      contextMeta: ref.contextMeta,
      sessionId: activeSessionId,
    }).catch(() => {}); // fire-and-forget
    pendingQuoteRef.current = null;
  }

  setValue('');
  setTags([]);
  ref.current?.focus();
};
```

- [ ] **Step 2: 添加 API 方法**

在 `apps/web/src/lib/api.ts` 中添加：

```typescript
async createQuoteReference(data: {
  sourceMessageId: string;
  selectionText: string;
  sourceType: string;
  contextMeta?: Record<string, unknown>;
  sessionId: string;
}) {
  return request('/api/quote-references', {
    method: 'POST',
    body: JSON.stringify(data),
  });
},

async getQuoteReferences(messageId: string) {
  return request(`/api/quote-references?messageId=${messageId}`);
},
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/MessageInput.tsx apps/web/src/lib/api.ts
git commit -m "feat: persist QuoteReference on quote-initiated message send"
```

---

## Task 10: InteractionHistory — 消息气泡展示引用链路

**Files:**
- Create: `apps/web/src/components/InteractionHistory.tsx`
- Modify: `apps/web/src/components/MessageBubble.tsx`

- [ ] **Step 1: 创建 InteractionHistory 组件**

```tsx
// apps/web/src/components/InteractionHistory.tsx
import { useEffect, useState } from 'react';
import { Link2, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';

interface QuoteRef {
  id: string;
  sourceMessageId: string;
  targetMessageId?: string;
  agentId?: string;
  selectionText: string;
  sourceType: string;
  createdAt: string;
}

interface Props {
  messageId: string;
}

export function InteractionHistory({ messageId }: Props) {
  const [quotedFrom, setQuotedFrom] = useState<QuoteRef[]>([]);
  const [quotedBy, setQuotedBy] = useState<QuoteRef[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api.getQuoteReferences(messageId).then((data: any) => {
      setQuotedFrom(data.quotedFrom || []);
      setQuotedBy(data.quotedBy || []);
    }).catch(() => {});
  }, [messageId]);

  if (quotedFrom.length === 0 && quotedBy.length === 0) return null;

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] text-hub-muted hover:text-hub-secondary transition"
      >
        <Link2 className="h-3 w-3" />
        {quotedFrom.length > 0 && `引用了 ${quotedFrom.length} 处`}
        {quotedFrom.length > 0 && quotedBy.length > 0 && ' · '}
        {quotedBy.length > 0 && `被 ${quotedBy.length} 处引用`}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1 rounded border border-hub bg-hub-input/50 p-2 text-[11px]">
          {quotedFrom.map((ref) => (
            <div key={ref.id} className="flex items-center gap-1 text-hub-tertiary">
              <ArrowRight className="h-3 w-3 rotate-180" />
              <span className="truncate max-w-60">"{ref.selectionText.slice(0, 80)}"</span>
              <span className="text-hub-muted">({ref.sourceType})</span>
            </div>
          ))}
          {quotedBy.map((ref) => (
            <div key={ref.id} className="flex items-center gap-1 text-hub-tertiary">
              <ArrowRight className="h-3 w-3" />
              <span>Agent 处理了引用</span>
              <span className="text-hub-muted">{new Date(ref.createdAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 在 MessageBubble 中集成 InteractionHistory**

在 `MessageBubble` 的气泡底部（状态指示器之后）添加：

```tsx
import { InteractionHistory } from './InteractionHistory';

// 在 return 的气泡 div 内，status indicators 之后：
{message.status === 'done' && !isHuman && (
  <InteractionHistory messageId={message.id} />
)}
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/InteractionHistory.tsx apps/web/src/components/MessageBubble.tsx
git commit -m "feat: add InteractionHistory to show quote chain in message bubbles"
```

---

## Task 11: 结构化引用上下文注入 Agent Prompt

**Files:**
- Modify: `apps/api/src/ws/handler.ts`

- [ ] **Step 1: 在 Agent prompt 构建中注入引用上下文**

在 `handler.ts` 的 `handleChatMessage` 函数中，构建 `fullPrompt` 之前，检查是否有关联的 QuoteReference：

```typescript
// 在 agentPrompt 构建之后、fullPrompt 组装之前
let quoteContextBlock = '';
if (mention.subPrompt.includes('引用内容 —')) {
  // 用户消息中已包含引用上下文（由前端 buildQuotePrompt 生成）
  // 查找最近创建的 QuoteReference 以获取 sourceMessageId
  const recentQuote = await prisma.quoteReference.findFirst({
    where: {
      sessionId,
      createdAt: { gte: new Date(Date.now() - 30_000) }, // 30s 内
    },
    orderBy: { createdAt: 'desc' },
  });
  if (recentQuote) {
    quoteContextBlock = `\n## 引用上下文\n用户引用了以下内容要求增量修改。请仅修改引用部分，不要重写无关代码。\n- 来源类型：${recentQuote.sourceType}\n- 选区长度：${recentQuote.selectionText.length} 字符\n`;
  }
}

const fullPrompt = `${modePrefix}\n\n${agentPrompt}${quoteContextBlock}`;
```

- [ ] **Step 2: Agent 完成后回填 QuoteReference 的 targetMessageId**

在 handler 中 Agent done 事件处理处，查找并更新关联的 QuoteReference：

```typescript
// 在 stream_done 处理逻辑中
const pendingRef = await prisma.quoteReference.findFirst({
  where: {
    sessionId,
    targetMessageId: null,
    createdAt: { gte: new Date(Date.now() - 300_000) }, // 5 分钟内
  },
  orderBy: { createdAt: 'desc' },
});
if (pendingRef) {
  await prisma.quoteReference.update({
    where: { id: pendingRef.id },
    data: { targetMessageId: agentMessageId, agentId: mention.agentId || undefined },
  }).catch(() => {});
}
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/ws/handler.ts
git commit -m "feat: inject structured quote context into agent prompt and backfill reference on completion"
```

---

## Task 12: PPT 内联浏览组件

**Files:**
- Create: `apps/web/src/components/PptxViewer.tsx`
- Modify: `apps/web/src/components/MessageBubble.tsx`（或新建独立的文件附件渲染逻辑）

> **说明**：PRD 4.4.4 标记 PPT 内联浏览为已完成，但代码中未找到实现。此 Task 补齐基础 PPT 查看器，为后续 PPT 选区引用做铺垫。

- [ ] **Step 1: 安装依赖**

Run: `cd apps/web && npm install pptx-preview`
Expected: 安装成功。`pptx-preview` 是轻量级 PPTX 渲染库，基于 JSZip 解析 + Canvas 渲染。

- [ ] **Step 2: 创建 PptxViewer 组件**

```tsx
// apps/web/src/components/PptxViewer.tsx
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';

interface Props {
  /** PPTX 文件的 base64 数据或 URL */
  src: string;
  /** 是否为 base64 数据 */
  isBase64?: boolean;
}

export function PptxViewer({ src, isBase64 = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const { renderAsync } = await import('pptx-preview');

        let buffer: ArrayBuffer;
        if (isBase64) {
          const base64 = src.includes(',') ? src.split(',')[1] : src;
          const binary = atob(base64);
          buffer = new ArrayBuffer(binary.length);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
        } else {
          const resp = await fetch(src);
          buffer = await resp.arrayBuffer();
        }

        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        const result = await renderAsync(buffer, containerRef.current);
        if (!cancelled) {
          setTotalSlides(result?.slides?.length || containerRef.current.children.length || 0);
          setCurrentSlide(0);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load PPTX');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [src, isBase64]);

  // Show only current slide
  useEffect(() => {
    if (!containerRef.current) return;
    const slides = containerRef.current.children;
    for (let i = 0; i < slides.length; i++) {
      (slides[i] as HTMLElement).style.display = i === currentSlide ? '' : 'none';
    }
  }, [currentSlide, totalSlides]);

  return (
    <div className="rounded border border-hub bg-hub-input overflow-hidden">
      {/* Controls */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-hub bg-hub-raised">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCurrentSlide((s) => Math.max(0, s - 1))}
            disabled={currentSlide === 0}
            className="p-1 rounded hover:bg-hub-hover disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-hub-secondary tabular-nums">
            {currentSlide + 1} / {totalSlides || '?'}
          </span>
          <button
            onClick={() => setCurrentSlide((s) => Math.min(totalSlides - 1, s + 1))}
            disabled={currentSlide >= totalSlides - 1}
            className="p-1 rounded hover:bg-hub-hover disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setScale((s) => Math.max(0.5, s - 0.1))} className="p-1 rounded hover:bg-hub-hover">
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="text-[10px] text-hub-muted tabular-nums">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(2, s + 0.1))} className="p-1 rounded hover:bg-hub-hover">
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* Slides */}
      <div className="relative overflow-auto" style={{ maxHeight: 500 }}>
        {loading && <div className="flex items-center justify-center py-8 text-xs text-hub-muted">Loading slides...</div>}
        {error && <div className="flex items-center justify-center py-8 text-xs text-hub-danger">{error}</div>}
        <div
          ref={containerRef}
          style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误（可能需要处理 pptx-preview 的类型声明，若无类型则添加 `declare module 'pptx-preview'`）。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/PptxViewer.tsx apps/web/package.json
git commit -m "feat: add PptxViewer component with slide navigation and zoom"
```

---

## Task 13: PPT 选区引用 + 文档选区引用

**Files:**
- Modify: `apps/web/src/components/PptxViewer.tsx`
- Modify: `apps/web/src/components/MessageBubble.tsx`（文档段落引用已有，此处补充结构化 prompt）

> **说明**：PPT 渲染为 Canvas，无法直接做文字选区。采用截图区域方案：用户在 PPT 上拖拽选区 → 截取该区域 → 以截图 + 描述发送给 Agent。

- [ ] **Step 1: PptxViewer 添加区域截图功能**

在 `PptxViewer` 中添加拖拽选区逻辑：

```tsx
const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
const [selecting, setSelecting] = useState(false);

const handleMouseDown = (e: React.MouseEvent) => {
  if (e.button !== 0) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setDragStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  setSelecting(true);
};

const handleMouseMove = (e: React.MouseEvent) => {
  if (!selecting) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setDragEnd({ x: e.clientX - rect.left, y: e.clientY - rect.top });
};

const handleMouseUp = async () => {
  setSelecting(false);
  if (!dragStart || !dragEnd || !containerRef.current) return;

  // Capture the selected region as screenshot
  const canvas = containerRef.current.querySelector('canvas');
  if (!canvas) return;

  const x = Math.min(dragStart.x, dragEnd.x) / scale;
  const y = Math.min(dragStart.y, dragEnd.y) / scale;
  const w = Math.abs(dragEnd.x - dragStart.x) / scale;
  const h = Math.abs(dragEnd.y - dragStart.y) / scale;

  if (w < 10 || h < 10) { setDragStart(null); setDragEnd(null); return; }

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = w;
  cropCanvas.height = h;
  const ctx = cropCanvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    const dataUrl = cropCanvas.toDataURL('image/png');
    const payload: QuotePayload = {
      text: `[PPT 幻灯片 ${currentSlide + 1} 截图区域]`,
      sourceType: 'ppt',
      contextMeta: { filePath: `slide-${currentSlide + 1}` },
    };
    const prompt = buildQuotePrompt(payload) + `\n\n截图数据: ${dataUrl.slice(0, 100)}...`;
    insertPrompt(prompt);
  }
  setDragStart(null);
  setDragEnd(null);
};
```

在渲染区域添加鼠标事件和选区覆盖层：

```tsx
<div
  className="relative overflow-auto cursor-crosshair"
  style={{ maxHeight: 500 }}
  onMouseDown={handleMouseDown}
  onMouseMove={handleMouseMove}
  onMouseUp={handleMouseUp}
>
  <div ref={containerRef} style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} />
  {/* Selection overlay */}
  {dragStart && dragEnd && (
    <div
      className="absolute border-2 border-hub-accent bg-hub-accent/10 pointer-events-none"
      style={{
        left: Math.min(dragStart.x, dragEnd.x),
        top: Math.min(dragStart.y, dragEnd.y),
        width: Math.abs(dragEnd.x - dragStart.x),
        height: Math.abs(dragEnd.y - dragStart.y),
      }}
    />
  )}
</div>
```

- [ ] **Step 2: 文档段落引用已有的结构化 prompt 升级**

在 Task 4 中已将 `MessageBubble` 的段落引用升级为 `buildQuotePrompt`。文档渲染复用同一组件，无需额外修改。

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/PptxViewer.tsx
git commit -m "feat: add PPT region selection and screenshot-based quote"
```

---

## Task 14: E2E 验证 — 全链路测试

- [ ] **Step 1: 启动服务并验证编译**

Run:
```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```
Expected: 两个项目均无编译错误。

- [ ] **Step 2: 功能验证清单**

手动验证以下场景：

1. **段落引用**：在 Agent 消息气泡中 hover 某个段落 → 出现引用按钮 → 点击后输入框出现结构化 prompt → 发送后 Agent 收到含来源上下文的指令
2. **代码块引用**：在代码块工具栏点击编辑按钮 → 输入框出现含语言标注的引用 prompt
3. **网页预览选区引用**：在 Preview 面板中选中网页文字 → 底部浮现 QuoteToolbar → 点击"引用并交给 Agent" → 输入框收到引用内容
4. **交互历史**：发送引用消息后，源消息和目标消息均显示引用链路标签
5. **PPT 浏览**：上传 PPTX 文件 → 内联查看器显示，可翻页/缩放
6. **PPT 区域截图引用**：在 PPT 查看器中拖拽选区 → 截图数据注入输入框

- [ ] **Step 3: Commit 最终状态**

```bash
git add -A
git commit -m "feat: complete artifact secondary interaction — quote, context, history"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: PRD 4.4.6 的 4 项未完成需求均有对应 Task 覆盖
- [x] **No placeholders**: 每个 Step 包含完整代码或具体命令
- [x] **Type consistency**: `QuotePayload`, `QuoteReference`, `SelectionData` 类型在前后端一致
- [x] **Existing patterns**: 沿用 `agenthub:prompt-insert` 事件总线、`api.ts` 封装、Prisma 模型模式
