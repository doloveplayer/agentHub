import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { prisma } from '../db/prisma.js';
import { DagPersistence } from './DagPersistence.js';
import { getSessionContextBus } from './ContextBus.js';
import { ExperienceExtractor, type ExtractionTask, type FailedTaskInfo } from './ExperienceExtractor.js';
import { AgentDirectoryManager } from './AgentDirectoryManager.js';
import { config } from '../config.js';
import type { ArchiveManifest, ExperienceEntry } from '@agenthub/shared';

const SANDBOXES_ROOT = config.sandbox.root;

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
      await ArchiveManager.writeExperiences(experiences, sessionId);
    }

    // Step 4: Cleanup from ContextBus
    bus.archive(planId);
    bus.clearNewKeys();

    // Step 5: Remove plan.json to prevent stale re-dispatch on restart
    ArchiveManager.cleanupPlanFile(sessionId, hostWorkDir);

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
    } catch { diffContent = '(git diff unavailable)'; console.warn('[ArchiveManager] git diff failed'); }

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
    } catch (err: any) { console.warn(`[ArchiveManager] git status failed: ${err.message}`); }

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

    // Persist to DB via DagPersistence
    await DagPersistence.markArchived(sessionId, planId);

    return manifest;
  }

  /** Step 3: Write experiences to agent memory directories (global + sandbox). */
  static async writeExperiences(experiences: ExperienceEntry[], sessionId?: string): Promise<void> {
    // Group by agentType
    const byAgent = new Map<string, ExperienceEntry[]>();
    for (const exp of experiences) {
      for (const agentType of exp.agentTypes) {
        if (!byAgent.has(agentType)) byAgent.set(agentType, []);
        byAgent.get(agentType)!.push(exp);
      }
    }

    // Fetch all agents once and match by exact name (case-insensitive)
    const allAgents = await prisma.agent.findMany({
      select: { id: true, name: true, systemPrompt: true },
    }).catch(() => [] as { id: string; name: string; systemPrompt: string }[]);

    for (const [agentType, exps] of byAgent) {
      try {
        const normalizedType = agentType.toLowerCase();
        const matched = allAgents.filter(a => a.name.toLowerCase() === normalizedType);
        if (matched.length === 0) {
          console.warn(`[ArchiveManager] No agent found for type "${agentType}", skipping ${exps.length} experiences`);
          continue;
        }
        for (const agent of matched) {
          const homeDir = AgentDirectoryManager.getAgentHome(agent.id);
          AgentDirectoryManager.ensureAgentHome(agent.id, agent.name, agent.systemPrompt);
          // Derive sandbox memory path for same-session visibility
          const sandboxMemoryDir = sessionId
            ? resolve(SANDBOXES_ROOT, sessionId, `_agent_${agent.name}`, '.claude', 'memory')
            : undefined;
          for (const exp of exps) {
            AgentDirectoryManager.writeAgentMemory(homeDir, exp, sandboxMemoryDir);
          }
        }
      } catch (err: any) {
        console.error(`[ArchiveManager] Failed to write memory for ${agentType}: ${err.message}`);
      }
    }
  }

  /** Remove plan.json from workspace and sandbox dirs after archiving. */
  private static cleanupPlanFile(sessionId: string, hostWorkDir: string): void {
    // The sandbox dir is typically the parent of hostWorkDir (when workspace is mounted at /workspace)
    const sandboxDir = resolve(SANDBOXES_ROOT, sessionId);
    const candidates = [
      resolve(hostWorkDir, 'plan.json'),
      resolve(sandboxDir, 'plan.json'),
    ];

    for (const path of candidates) {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
          console.log(`[ArchiveManager] Cleaned up plan.json: ${path}`);
        } catch (err: any) {
          console.warn(`[ArchiveManager] Failed to remove plan.json (${path}): ${err.message}`);
        }
      }
    }
  }
}
