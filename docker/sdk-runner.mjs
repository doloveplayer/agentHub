#!/usr/bin/env node
/**
 * SDK runner — executes inside the sandbox Docker container via `docker exec`.
 *
 * Permission flow:
 *   canUseTool callback auto-approves all non-Write tools. For Write/Edit/
 *   MultiEdit, it writes a custom_permission_request to stdout and waits
 *   for the host (backend) to respond via stdin with JSON-Lines protocol.
 *
 *   The host writes {"permissionId":"perm-xxx","allowed":true} to stdin,
 *   which is picked up by this runner's stdin handler and routed to the
 *   correct canUseTool Promise via permissionResolvers.
 */

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const globalRequire = createRequire('/usr/local/lib/node_modules/');
const sdkPath = globalRequire.resolve('@anthropic-ai/claude-agent-sdk');
const { query } = await import(sdkPath);

const promptFile = process.env.AGENTHUB_PROMPT_FILE;
if (!promptFile) {
  process.stderr.write('ERROR: AGENTHUB_PROMPT_FILE not set\n');
  process.exit(1);
}

let prompt;
try {
  prompt = readFileSync(promptFile, 'utf-8');
} catch (err) {
  process.stderr.write(`ERROR: cannot read prompt file: ${err.message}\n`);
  process.exit(1);
}

const permissionMode = process.env.AGENTHUB_PERMISSION_MODE || 'default';
const model = process.env.AGENTHUB_MODEL || undefined;
const resumeSession = process.env.AGENTHUB_RESUME_SESSION || undefined;
const maxTurns = process.env.AGENTHUB_MAX_TURNS ? parseInt(process.env.AGENTHUB_MAX_TURNS, 10) : undefined;
const effort = process.env.AGENTHUB_EFFORT || process.env.AGENTHUB_THINKING_EFFORT || undefined;

const thinkingBudget = process.env.AGENTHUB_THINKING_BUDGET
  ? parseInt(process.env.AGENTHUB_THINKING_BUDGET, 10)
  : 16000;
const thinking = thinkingBudget > 0 ? { type: 'enabled', budget_tokens: thinkingBudget } : undefined;

let allowedTools = [];
if (process.env.AGENTHUB_ALLOWED_TOOLS) {
  try {
    allowedTools = JSON.parse(process.env.AGENTHUB_ALLOWED_TOOLS);
  } catch { /* ignore */ }
}

// Permission response queue: maps permissionId → resolver
const permissionResolvers = new Map();

// Read stdin for permission responses from the host
let stdinBuffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const resp = JSON.parse(line);
      if (resp.permissionId) {
        const resolver = permissionResolvers.get(resp.permissionId);
        if (resolver) {
          permissionResolvers.delete(resp.permissionId);
          resolver(resp);
        }
      }
    } catch { /* ignore */ }
  }
});
process.stdin.resume();

async function canUseTool(toolName, toolInput, options) {
  const signal = options?.signal;
  const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

  if (!WRITE_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: toolInput };
  }

  const permissionId = `perm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = toolInput?.file_path || toolInput?.path || undefined;

  // Read old content for diff (best-effort)
  let oldContent = undefined;
  if (filePath) {
    const absPath = resolve('/workspace', filePath.startsWith('/') ? filePath.slice(1) : filePath);
    if (absPath.startsWith('/workspace/') || absPath === '/workspace') {
      try {
        if (existsSync(absPath)) {
          oldContent = readFileSync(absPath, 'utf-8').slice(0, 50000);
        }
      } catch { /* file may not exist yet */ }
    }
  }

  // Write request to stdout
  process.stdout.write(JSON.stringify({
    type: 'custom_permission_request',
    permissionId,
    tool: toolName,
    filePath,
    input: toolInput,
    oldContent,
  }) + '\n');

  // Wait for response, respecting the abort signal
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ behavior: 'deny', message: 'Permission check aborted by SDK' });
      return;
    }
    const onAbort = () => {
      permissionResolvers.delete(permissionId);
      resolve({ behavior: 'deny', message: 'Permission check aborted by SDK' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    permissionResolvers.set(permissionId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      if (response.allowed) {
        resolve({ behavior: 'allow', updatedInput: toolInput });
      } else {
        resolve({ behavior: 'deny', message: 'Permission denied by user' });
      }
    });
  });
}

const options = {
  cwd: '/workspace',
  model,
  resume: resumeSession,
  permissionMode,
  allowedTools,
  maxTurns,
  effort,
  thinking,
  env: process.env,
  canUseTool,
};

if (permissionMode === 'bypassPermissions') {
  options.allowDangerouslySkipPermissions = true;
}

let exitCode = 1;

try {
  for await (const message of query({ prompt, options })) {
    process.stdout.write(JSON.stringify(message) + '\n');

    // Track result for exit code
    if (message.type === 'result') {
      exitCode = message.subtype === 'success' ? 0 : 1;
    }
  }
} catch (err) {
  process.stderr.write(`ERROR: ${err.message}\n`);
  exitCode = 1;
}

process.exit(exitCode);
