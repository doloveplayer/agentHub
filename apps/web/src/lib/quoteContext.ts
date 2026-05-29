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
