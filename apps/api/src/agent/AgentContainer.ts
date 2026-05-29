import Docker from 'dockerode';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { rm } from 'fs/promises';
import { resolve } from 'path';
import { config } from '../config.js';

const docker = new Docker({ socketPath: config.sandbox.hostDockerSocket });

export interface ContainerInfo {
  containerId: string;
  workDir: string;
  hostWorkDir: string;
}

export class AgentContainer {
  /** Create and start a Docker container for a single agent */
  static async create(agentId: string, systemPrompt: string): Promise<ContainerInfo> {
    const containerName = `agenthub-agent-${agentId}`;
    const hostWorkDir = resolve(config.agentContainer.hostRoot, agentId);
    const workDir = '/workspace';

    // Ensure host dirs exist
    const claudeDir = resolve(hostWorkDir, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(resolve(claudeDir, 'memory'), { recursive: true });
      mkdirSync(resolve(claudeDir, 'skills'), { recursive: true });
    }

    // Write CLAUDE.md with agent identity
    writeFileSync(
      resolve(hostWorkDir, 'CLAUDE.md'),
      `# Agent Identity\n\n${systemPrompt}\n\n## Collaboration Rules\n- Your workspace is at /workspace.\n- Your personal files (memory, config) are at /workspace/.claude/\n- This CLAUDE.md defines your persistent identity. The user message passed at runtime contains only the task.`,
      'utf-8',
    );

    // Remove existing container with same name if any
    await AgentContainer.removeIfExists(containerName);

    const container = await docker.createContainer({
      name: containerName,
      Image: config.agentContainer.image,
      WorkingDir: workDir,
      Tty: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      HostConfig: {
        Memory: config.agentContainer.memoryMb * 1024 * 1024,
        MemorySwap: config.agentContainer.memoryMb * 1024 * 1024 * 2,
        NetworkMode: 'bridge',
        Binds: [`${hostWorkDir}:/workspace`],
      },
    });

    await container.start();

    return { containerId: container.id, workDir, hostWorkDir };
  }

  /** Stop and remove agent container */
  static async destroy(containerId: string): Promise<void> {
    try {
      const container = docker.getContainer(containerId);
      await container.stop({ t: 10 });
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode === 404) return; // Already gone
      throw err;
    }
  }

  /** Destroy host work dir (irreversible) */
  static async destroyHostDir(agentId: string): Promise<void> {
    const hostWorkDir = resolve(config.agentContainer.hostRoot, agentId);
    try {
      await rm(hostWorkDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  private static async removeIfExists(name: string): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true, filters: { name: [name] } });
      for (const c of containers) {
        await AgentContainer.destroy(c.Id);
      }
    } catch {
      /* ignore */
    }
  }
}
