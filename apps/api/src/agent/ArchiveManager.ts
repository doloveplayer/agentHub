import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { prisma } from '../db/prisma.js';
import { getSessionContextBus } from './ContextBus.js';
import { ExperienceExtractor, type ExtractionTask, type FailedTaskInfo } from './ExperienceExtractor.js';
import { AgentDirectoryManager } from './AgentDirectoryManager.js';
import type { ArchiveManifest, ExperienceEntry } from '@agenthub/shared';

const SANDBOXES_ROOT = '.sandboxes';

export class ArchiveManager {
  /** Execute the full archive pipeline for a completed plan. */
  static async archivePlan(
    sessionId: string,
    planId: string,
    planTitle: string,
    tasks: ExtractionTask[],
    failedTasks: FailedTaskInfo[],
    hostWorkDir: string,
    startTime: number,
  ): Promise<{ manifest: ArchiveManifest; experiences: ExperienceEntry[] }> {
    const bus = getSessionContextBus(sessionId);

    // Step 1: Product snapshot
    const manifest = await ArchiveManager.createSnapshot(sessionId, planId, planTitle, tasks, hostWorkDir, startTime);

    // Step 2: Experience extraction (rule engine)
    const extractor = new ExperienceExtractor();
    const experiences = extractor.extract({ planId, sessionId, tasks, failedTasks, contextBus: bus });

    // Step 3: Write experiences to agent memory
    if (experiences.length > 0) {
      await ArchiveManager.writeExperiences(experiences);
    }

    // Step 4: Cleanup from ContextBus
    bus.archive(planId);

    return { manifest, experiences };
  }

  /** Step 1: Create product snapshot — manifest.json + diff.patch. */
  private static async createSnapshot(
    sessionId: string,
    planId: string,
    planTitle: string,
    tasks: ExtractionTask[],
    hostWorkDir: string,
    startTime: number,
  ): Promise<ArchiveManifest> {
    const archiveDir = resolve(SANDBOXES_ROOT, sessionId, 'archive', planId);
    mkdirSync(archiveDir, { recursive: true });

    // Collect git diff
    let diffContent = '';
    try {
      diffContent = execSync('git diff --stat HEAD', {
        cwd: hostWorkDir, encoding: 'utf-8', timeout: 10000,
      });
    } catch { diffContent = '(git diff unavailable)'; }

    // Collect file changes
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    try {
      const status = execSync('git status --porcelain', {
        cwd: hostWorkDir, encoding: 'utf-8', timeout: 5000,
      });
      for (const line of status.trim().split('\n')) {
        if (!line) continue;
        const code = line.slice(0, 2).trim();
        const file = line.slice(3).trim();
        if (code === '??' || code === 'A') added.push(file);
        else if (code === 'D') removed.push(file);
        else modified.push(file);
      }
    } catch { /* ignore */ }

    const durationMs = Date.now() - startTime;
    const manifest: ArchiveManifest = {
      planId,
      sessionId,
      planTitle,
      completedAt: new Date().toISOString(),
      durationMs,
      tasks: tasks.map(t => ({
        id: t.id,
        title: t.title,
        agentType: t.agentType,
        status: t.status,
        outputFiles: t.outputFiles,
        modifiedFiles: t.modifiedFiles,
        outputSummary: t.outputSummary.slice(0, 300),
      })),
      fileChanges: { added, modified, removed },
      contextEntries: getSessionContextBus(sessionId).query({ planId }).map(e => ({
        key: e.key, type: e.type, status: e.status,
      })),
    };

    writeFileSync(resolve(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    writeFileSync(resolve(archiveDir, 'diff.patch'), diffContent, 'utf-8');

    // Persist to DB
    await prisma.planExecution.updateMany({
      where: { sessionId, planId },
      data: { status: 'archived' },
    }).catch(() => {});

    return manifest;
  }

  /** Step 3: Write experiences to agent memory directories. */
  static async writeExperiences(experiences: ExperienceEntry[]): Promise<void> {
    // Group by agentType
    const byAgent = new Map<string, ExperienceEntry[]>();
    for (const exp of experiences) {
      for (const agentType of exp.agentTypes) {
        if (!byAgent.has(agentType)) byAgent.set(agentType, []);
        byAgent.get(agentType)!.push(exp);
      }
    }

    for (const [agentType, exps] of byAgent) {
      try {
        const agents = await prisma.agent.findMany({
          where: { name: { contains: agentType, mode: 'insensitive' } },
          select: { id: true, name: true, systemPrompt: true },
        });
        for (const agent of agents) {
          const homeDir = AgentDirectoryManager.getAgentHome(agent.id);
          AgentDirectoryManager.ensureAgentHome(agent.id, agent.name, agent.systemPrompt);
          for (const exp of exps) {
            AgentDirectoryManager.writeAgentMemory(homeDir, exp);
          }
        }
      } catch (err: any) {
        console.error(`[ArchiveManager] Failed to write memory for ${agentType}: ${err.message}`);
      }
    }
  }
}
