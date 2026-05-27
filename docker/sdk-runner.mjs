#!/usr/bin/env node
/**
 * SDK runner — executes inside the sandbox Docker container via `docker exec`.
 *
 * Reads a prompt from a file, calls @anthropic-ai/claude-agent-sdk's query(),
 * and streams each SDK message as a JSON line to stdout.
 *
 * Env vars (set by host via docker exec -e):
 *   AGENTHUB_PROMPT_FILE       path to prompt file (required)
 *   AGENTHUB_PERMISSION_MODE   SDK permission mode (default: "default")
 *   AGENTHUB_ALLOWED_TOOLS     JSON array of allowed tool names (default: [])
 *   AGENTHUB_MODEL             model override (optional)
 *   AGENTHUB_RESUME_SESSION    session ID for --resume (optional)
 *   AGENTHUB_MAX_TURNS         max turns (optional)
 *   AGENTHUB_EFFORT            SDK effort level (optional)
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';

// ESM can't resolve globally-installed packages by name. Use createRequire to
// locate the package, then import the resolved absolute path.
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
const effort = process.env.AGENTHUB_EFFORT || undefined;

let allowedTools = [];
if (process.env.AGENTHUB_ALLOWED_TOOLS) {
  try {
    allowedTools = JSON.parse(process.env.AGENTHUB_ALLOWED_TOOLS);
  } catch {
    process.stderr.write('WARNING: AGENTHUB_ALLOWED_TOOLS is not valid JSON, ignoring\n');
  }
}

const options = {
  cwd: '/workspace',
  model,
  resume: resumeSession,
  permissionMode,
  allowedTools,
  maxTurns,
  effort,
  settingSources: ['project'],
  env: process.env,
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
