import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function claudeConfigMount(args: string[]): string {
  const mount = args.find((arg) => arg.endsWith(':/home/node/.claude'));
  assert.ok(mount, 'expected CLAUDE_CONFIG_DIR bind mount');
  return mount.split(':')[0];
}

async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > 1000) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('ClaudeCodeProcess keeps Claude config stable per agent when resuming across message prompts', async () => {
  const { ClaudeCodeProcess } = await import('./ClaudeCodeProcess.js');
  const workDir = mkdtempSync(join(tmpdir(), 'agenthub-claude-process-'));
  const fakeBin = join(workDir, 'bin');
  const logPath = join(workDir, 'docker-args.log');
  const dockerPath = join(fakeBin, 'docker');
  const oldPath = process.env.PATH;
  const oldLog = process.env.AGENTHUB_DOCKER_ARGS_LOG;

  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      dockerPath,
      [
        '#!/bin/sh',
        '{',
        '  echo "===CALL==="',
        '  for arg in "$@"; do printf "%s\\n" "$arg"; done',
        '} >> "$AGENTHUB_DOCKER_ARGS_LOG"',
      ].join('\n'),
      'utf8',
    );
    chmodSync(dockerPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath || ''}`;
    process.env.AGENTHUB_DOCKER_ARGS_LOG = logPath;

    await (new ClaudeCodeProcess() as any).start(
      'session-12345678',
      'first prompt',
      'container-id',
      '/workspace',
      true,
      workDir,
      'message-one',
      undefined,
      'code-agent',
    );
    await (new ClaudeCodeProcess() as any).start(
      'session-12345678',
      'second prompt',
      'container-id',
      '/workspace',
      true,
      workDir,
      'message-two',
      'claude-session-id',
      'code-agent',
    );

    await waitForFile(logPath);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const spawnCalls = readFileSync(logPath, 'utf8')
      .split('===CALL===')
      .map((call) => call.trim().split('\n').filter(Boolean))
      .filter((call) => call.length > 0);

    assert.equal(spawnCalls.length, 2);
    assert.notEqual(spawnCalls[0].join(' '), spawnCalls[1].join(' '), 'prompt/container args stay message-specific');
    assert.equal(claudeConfigMount(spawnCalls[0]), claudeConfigMount(spawnCalls[1]), 'resume uses the same agent config directory');
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.AGENTHUB_DOCKER_ARGS_LOG;
    else process.env.AGENTHUB_DOCKER_ARGS_LOG = oldLog;
    rmSync(workDir, { recursive: true, force: true });
  }
});
