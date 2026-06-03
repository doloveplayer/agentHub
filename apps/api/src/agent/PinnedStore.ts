import { prisma } from '../db/prisma.js';
import { readFileSync, existsSync } from 'fs';
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
    const maxOrder = await prisma.pinnedMessage.aggregate({
      where: { sessionId },
      _max: { sortOrder: true },
    });
    const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;

    return prisma.pinnedMessage.create({
      data: {
        sessionId,
        sourceType,
        content,
        sourceMessageId: options?.sourceMessageId ?? null,
        filePath: options?.filePath ?? null,
        title: options?.title ?? null,
        injectToAgent: options?.injectToAgent ?? true,
        sortOrder: nextOrder,
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
      where: { id: pinnedId },
      data,
    });
  }

  static async reorder(sessionId: string, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) {
      await prisma.pinnedMessage.updateMany({
        where: { id: ids[i], sessionId },
        data: { sortOrder: i },
      });
    }
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
          if (existsSync(fullPath)) {
            try {
              fileContent = readFileSync(fullPath, 'utf-8').slice(0, 200);
            } catch {
              fileContent = '(read error)';
            }
          } else {
            fileContent = '(file not found)';
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
