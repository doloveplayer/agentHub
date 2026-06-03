import { prisma } from '../db/prisma.js';
import { readFile, access } from 'fs/promises';
import { resolve } from 'path';
import { estimateTokens } from '@agenthub/shared';

export interface PinnedMessageData {
  id: string;
  sessionId: string;
  sourceType: string;
  sourceMessageId: string | null;
  filePath: string | null;
  content: string;
  title: string | null;
  injectToAgent: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export class PinnedStore {
  static async add(
    sessionId: string,
    sourceType: 'message' | 'file' | 'text',
    content: string,
    options?: { sourceMessageId?: string; filePath?: string; title?: string; injectToAgent?: boolean },
  ): Promise<PinnedMessageData> {
    const count = await prisma.pinnedMessage.count({ where: { sessionId } });

    return prisma.pinnedMessage.create({
      data: {
        sessionId,
        sourceType,
        content,
        sourceMessageId: options?.sourceMessageId ?? null,
        filePath: options?.filePath ?? null,
        title: options?.title ?? null,
        injectToAgent: options?.injectToAgent ?? true,
        sortOrder: count,
      },
    });
  }

  static async remove(sessionId: string, pinnedId: string): Promise<void> {
    await prisma.pinnedMessage.deleteMany({
      where: { id: pinnedId, sessionId },
    });
  }

  static async list(sessionId: string): Promise<PinnedMessageData[]> {
    return prisma.pinnedMessage.findMany({
      where: { sessionId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  static async update(
    sessionId: string,
    pinnedId: string,
    data: { injectToAgent?: boolean; sortOrder?: number; title?: string },
  ): Promise<PinnedMessageData | null> {
    const existing = await prisma.pinnedMessage.findFirst({
      where: { id: pinnedId, sessionId },
    });
    if (!existing) return null;

    return prisma.pinnedMessage.update({
      where: { id: pinnedId, sessionId },
      data,
    });
  }

  static async reorder(sessionId: string, ids: string[]): Promise<void> {
    await prisma.$transaction(
      ids.map((id, i) =>
        prisma.pinnedMessage.updateMany({
          where: { id, sessionId },
          data: { sortOrder: i },
        })
      )
    );
  }

  static async pinFromMessage(sessionId: string, messageId: string): Promise<PinnedMessageData | null> {
    const message = await prisma.message.findFirst({
      where: { id: messageId, sessionId },
    });
    if (!message) return null;

    const content = message.content.slice(0, 2000);
    const title = content.slice(0, 80).split('\n')[0];

    return PinnedStore.add(sessionId, 'message', content, {
      sourceMessageId: messageId,
      title,
    });
  }

  static async pinFromFile(sessionId: string, filePath: string, hostWorkDir?: string): Promise<PinnedMessageData | null> {
    return PinnedStore.add(sessionId, 'file', filePath, {
      filePath,
      title: filePath.split('/').pop() ?? filePath,
    });
  }

  static async buildInjectionPrompt(sessionId: string, maxTokens: number, hostWorkDir?: string): Promise<string> {
    const pinned = await PinnedStore.list(sessionId);
    const injectable = pinned.filter(p => p.injectToAgent);
    if (injectable.length === 0) return '';

    let result = '## Pinned Context (用户置顶)\n';
    let remainingTokens = maxTokens - estimateTokens(result);

    for (const pin of injectable) {
      let line: string;

      if (pin.sourceType === 'file' && pin.filePath) {
        let fileContent = '';
        if (hostWorkDir) {
          const fullPath = resolve(hostWorkDir, pin.filePath.replace(/^\/workspace\/?/, ''));
          if (!fullPath.startsWith(resolve(hostWorkDir))) {
            fileContent = '(invalid path)';
          } else {
            try {
              await access(fullPath);
              fileContent = (await readFile(fullPath, 'utf-8')).slice(0, 200);
            } catch {
              fileContent = '(file not found)';
            }
          }
        }
        line = `- [PINNED] ${pin.filePath} — ${fileContent}\n`;
      } else if (pin.sourceType === 'message') {
        const preview = pin.content.slice(0, 150).replace(/\n/g, ' ');
        line = `- [PINNED] ${pin.title ?? 'Message'}: ${preview}\n`;
      } else {
        const preview = pin.content.slice(0, 150).replace(/\n/g, ' ');
        line = `- [PINNED] ${pin.title ?? 'Note'}: ${preview}\n`;
      }

      const lineTokens = estimateTokens(line);
      if (lineTokens > remainingTokens) break;
      result += line;
      remainingTokens -= lineTokens;
    }

    return result;
  }
}
