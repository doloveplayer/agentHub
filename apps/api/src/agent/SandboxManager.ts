import { mkdirSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import Docker from 'dockerode';
import type { Duplex } from 'stream';
import { config } from '../config.js';

const docker = new Docker({ socketPath: config.sandbox.hostDockerSocket });
const SANDBOXES_ROOT = config.sandbox.root;

export interface SandboxInfo {
  containerId: string;
  workDir: string;       // container path (/workspace)
  hostWorkDir: string;   // host path
}

export class SandboxManager {
  static async create(sessionId: string): Promise<SandboxInfo> {
    const hostWorkDir = resolve(SANDBOXES_ROOT, sessionId);
    if (!existsSync(hostWorkDir)) {
      mkdirSync(hostWorkDir, { recursive: true });
    }

    const containerName = `agenthub-sandbox-${sessionId}`;

    // Clean up any stale container with same name
    await this.cleanupContainer(containerName);

    const container = await docker.createContainer({
      name: containerName,
      Image: config.sandbox.image,
      WorkingDir: '/workspace',
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        Binds: [`${hostWorkDir}:/workspace`],
      },
    });

    await container.start();

    return {
      containerId: container.id,
      workDir: '/workspace',
      hostWorkDir,
    };
  }

  /**
   * Execute a command inside a Docker container with real-time streaming output.
   * Used for long-running Claude Code processes.
   */
  static async execStream(
    containerId: string,
    command: string[],
    opts: {
      workDir?: string;
      stdin?: string;
      env?: Record<string, string>;
      keepStdinOpen?: boolean;
      onStdin?: (stdin: NodeJS.WritableStream) => void;
      onStdout: (chunk: string) => void;
      onStderr: (chunk: string) => void;
    },
  ): Promise<{ exitCode: number }> {
    const container = docker.getContainer(containerId);

    // Convert env object to Docker format: ["KEY=VALUE", ...]
    const envList = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : undefined;

    const attachStdin = !!opts.stdin || !!opts.keepStdinOpen;

    const exec = await container.exec({
      Cmd: command,
      WorkingDir: opts.workDir ?? '/workspace',
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: attachStdin,
      Env: envList,
    });

    const stream = await exec.start({ Detach: false, Tty: false, stdin: attachStdin });

    // Write stdin and conditionally keep open for interactive permission responses
    const streamAny = stream as any;
    if (opts.stdin && streamAny.stdin) {
      streamAny.stdin.write(opts.stdin);
    }
    if (opts.keepStdinOpen && streamAny.stdin) {
      // Prime the stdin stream. Docker's multiplexed stdin channel needs at least
      // one write to properly initialize. A single newline is harmless:
      // in `cat file - | claude` mode, the newline passes through as a blank input
      // separator and Claude Code REPL ignores it.
      streamAny.stdin.write('\n');
      if (opts.onStdin) opts.onStdin(streamAny.stdin);
    } else if (opts.stdin && streamAny.stdin) {
      streamAny.stdin.end();
    }

    let stdoutBuf = '';
    let stderrBuf = '';

    await new Promise<void>((resolve, reject) => {
      docker.modem.demuxStream(
        stream as Duplex,
        {
          write: (chunk: unknown) => {
            const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
            stdoutBuf += s;
            opts.onStdout(s);
            return true;
          },
        } as any,
        {
          write: (chunk: unknown) => {
            const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
            stderrBuf += s;
            opts.onStderr(s);
            return true;
          },
        } as any,
      );

      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const inspect = await exec.inspect();
    return { exitCode: inspect.ExitCode ?? 0 };
  }

  /** Fire-and-forget shell command inside container (no streaming) */
  static execShell(containerId: string, shellCmd: string): void {
    const container = docker.getContainer(containerId);
    container.exec({
      Cmd: ['sh', '-c', shellCmd],
      AttachStdout: false,
      AttachStderr: false,
    }).then((exec) => exec.start({ Detach: true })).catch(() => {});
  }

  /** Execute a command and capture stdout as a string (non-streaming) */
  static async execCapture(containerId: string, shellCmd: string): Promise<string> {
    const container = docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ['sh', '-c', shellCmd],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ Detach: false, Tty: false });
    let output = '';
    await new Promise<void>((resolve, reject) => {
      docker.modem.demuxStream(
        stream as any,
        { write: (chunk: unknown) => {
          output += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
          return true;
        } } as any,
        { write: () => true } as any,
      );
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return output.trim();
  }

  /** Destroy Docker container */
  static async destroy(containerId: string): Promise<void> {
    try {
      const container = docker.getContainer(containerId);
      try { await container.stop({ t: 5 }); } catch { /* ignore */ }
      await container.remove({ force: true });
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
  }

  /** Remove host sandbox directory */
  static destroyHostDir(sessionId: string): void {
    const hostWorkDir = resolve(SANDBOXES_ROOT, sessionId);
    try {
      if (existsSync(hostWorkDir)) {
        rmSync(hostWorkDir, { recursive: true, force: true });
      }
    } catch (err: any) {
      console.error(`[sandbox] Failed to remove host dir ${hostWorkDir}: ${err.message}`);
    }
  }

  private static async cleanupContainer(containerName: string): Promise<void> {
    try {
      const containers = await docker.listContainers({
        all: true,
        filters: { name: [containerName] },
      });
      for (const info of containers) {
        await this.destroy(info.Id);
      }
    } catch { /* best-effort */ }
  }
}
