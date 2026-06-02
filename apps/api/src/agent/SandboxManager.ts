import { mkdirSync, existsSync, rmSync } from 'fs';
import http from 'http';
import net from 'net';
import { resolve } from 'path';
import Docker from 'dockerode';
import type { Duplex } from 'stream';
import { config } from '../config.js';

const docker = new Docker({ socketPath: config.sandbox.hostDockerSocket });
const SANDBOXES_ROOT = config.sandbox.root;

export interface SandboxInfo {
  containerId: string;
  workDir: string;       // container path (/workspace) — user's working directory
  hostWorkDir: string;   // host path to user workspace
  sandboxDir: string;    // container path (/sandbox) — agent config + runtime files
  hostSandboxDir: string; // host path to sandbox directory
}

export interface PortForwardInfo {
  containerId: string;
  containerPort: number;
  hostPort: number;
  url: string;
}

const portForwards = new Map<string, { server: http.Server; info: PortForwardInfo }>();

export class SandboxManager {
  static async create(sessionId: string, memoryMb?: number, customHostWorkDir?: string): Promise<SandboxInfo> {
    // Sandbox directory is ALWAYS the default path — agent config + runtime files
    const hostSandboxDir = resolve(SANDBOXES_ROOT, sessionId);
    if (!existsSync(hostSandboxDir)) {
      mkdirSync(hostSandboxDir, { recursive: true });
    }

    // User workspace: custom path if provided, otherwise same as sandbox
    const hostWorkDir = customHostWorkDir || hostSandboxDir;

    // Validate that custom directory exists
    if (customHostWorkDir && !existsSync(customHostWorkDir)) {
      throw new Error(`Custom workspace directory does not exist: ${customHostWorkDir}`);
    }

    const containerName = `agenthub-sandbox-${sessionId}`;

    // Clean up any stale container with same name
    await this.cleanupContainer(containerName);

    const mem = memoryMb ?? config.sandbox.soloMemoryMb;

    // Binds: sandbox dir (agent runtime), workspace (user files), agents home (persistent identity)
    // Always bind-mount both paths. When hostWorkDir === hostSandboxDir, Docker
    // correctly mounts the same host directory to both container paths.
    const binds = [
      `${hostSandboxDir}:/sandbox`,
      `${hostWorkDir}:/workspace`,
    ];
    // Mount entire agents directory for per-agent persistent homes
    const agentsRoot = config.agentContainer.hostRoot;
    if (existsSync(agentsRoot)) {
      binds.push(`${agentsRoot}:/home/agents`);
    }

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
        Memory: mem * 1024 * 1024,
        Binds: binds,
      },
    });

    await container.start();

    return {
      containerId: container.id,
      workDir: '/workspace',
      hostWorkDir,
      sandboxDir: '/sandbox',
      hostSandboxDir,
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

    // Docker multiplex protocol: stdin frames need an 8-byte header.
    // [stream_type:1byte][0:3bytes][size:4bytes-BE]
    function muxWrite(data: string): void {
      const buf = Buffer.from(data);
      const header = Buffer.alloc(8);
      header.writeUInt8(0, 0);  // stream 0 = stdin
      header.writeUInt32BE(buf.length, 4);
      (stream as any).write(Buffer.concat([header, buf]));
    }

    let stdoutBuf = '';
    let stderrBuf = '';

    // CRITICAL: Start the demux loop BEFORE writing stdin data.
    // If stdin is written before the `data` handler is attached, Docker's
    // stdout response frames (e.g., cat echoing stdin) will be lost.
    const demuxReady = new Promise<void>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let settled = false;
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const streamType = buf.readUInt8(0);
          const payloadLen = buf.readUInt32BE(4);
          if (buf.length < 8 + payloadLen) break;
          const payload = buf.slice(8, 8 + payloadLen);
          buf = buf.slice(8 + payloadLen);
          const s = payload.toString('utf-8');
          if (streamType === 1) { stdoutBuf += s; opts.onStdout(s); }
          else if (streamType === 2) { stderrBuf += s; opts.onStderr(s); }
        }
      };
      (stream as any).on('data', onData);
      stream.on('end', () => { if (!settled) { settled = true; resolve(); } });
      stream.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    });

    // Now write stdin data AFTER the demux is listening
    if (opts.stdin) muxWrite(opts.stdin);
    if (opts.keepStdinOpen) {
      muxWrite('\n'); // prime the channel
      if (opts.onStdin) {
        opts.onStdin({
          write: (data: string) => muxWrite(data),
          end: () => {},
        } as NodeJS.WritableStream);
      }
    } else if (opts.stdin) {
      muxWrite('');
    }

    await demuxReady;

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

  static async detectPorts(containerId: string): Promise<number[]> {
    const output = await this.execCapture(containerId, 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true');
    return parseListeningPorts(output);
  }

  static async portForward(containerId: string, containerPort: number): Promise<PortForwardInfo> {
    const key = `${containerId}:${containerPort}`;
    const existing = portForwards.get(key);
    if (existing) return existing.info;

    const container = docker.getContainer(containerId);
    const inspect = await container.inspect();
    const containerHost = resolveContainerHost(inspect);
    if (!containerHost) throw new Error('Unable to resolve sandbox container IP address');

    const server = http.createServer((req, res) => {
      const proxyReq = http.request({
        hostname: containerHost,
        port: containerPort,
        path: req.url || '/',
        method: req.method,
        headers: req.headers,
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Preview proxy error: ${err.message}`);
      });
      req.pipe(proxyReq);
    });

    server.on('upgrade', (req, socket, head) => {
      const upstream = net.connect(containerPort, containerHost, () => {
        upstream.write(`${req.method} ${req.url || '/'} HTTP/${req.httpVersion}\r\n`);
        for (const [name, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) upstream.write(`${name}: ${value.join(', ')}\r\n`);
          else if (value) upstream.write(`${name}: ${value}\r\n`);
        }
        upstream.write('\r\n');
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '0.0.0.0', () => {
        server.off('error', rejectListen);
        resolveListen();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Preview proxy did not bind to a TCP port');
    }
    const info: PortForwardInfo = {
      containerId,
      containerPort,
      hostPort: address.port,
      url: `http://localhost:${address.port}`,
    };
    portForwards.set(key, { server, info });
    return info;
  }

  static async getContainerHost(containerId: string): Promise<string | null> {
    const inspect = await docker.getContainer(containerId).inspect();
    return resolveContainerHost(inspect);
  }

  /** Destroy Docker container */
  static async destroy(containerId: string): Promise<void> {
    try {
      for (const [key, forward] of [...portForwards]) {
        if (forward.info.containerId === containerId) {
          forward.server.close();
          portForwards.delete(key);
        }
      }
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

export function parseListeningPorts(procNetTcp: string): number[] {
  const ports = new Set<number>();
  for (const line of procNetTcp.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[3] !== '0A') continue;
    const local = parts[1];
    const hexPort = local?.split(':')[1];
    if (!hexPort) continue;
    const port = Number.parseInt(hexPort, 16);
    if (Number.isFinite(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function resolveContainerHost(inspect: any): string | null {
  const networks = inspect?.NetworkSettings?.Networks ?? {};
  for (const network of Object.values<any>(networks)) {
    if (network?.IPAddress) return network.IPAddress;
  }
  return inspect?.NetworkSettings?.IPAddress || null;
}
