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

test('ClaudeCodeProcess passes provider env through docker args without workspace env file', async () => {
  const { ClaudeCodeProcess } = await import('./ClaudeCodeProcess.js');
  const workDir = mkdtempSync(join(tmpdir(), 'agenthub-claude-env-'));
  const fakeBin = join(workDir, 'bin');
  const logPath = join(workDir, 'docker-args.log');
  const dockerPath = join(fakeBin, 'docker');
  const oldPath = process.env.PATH;
  const oldLog = process.env.AGENTHUB_DOCKER_ARGS_LOG;
  const oldToken = process.env.ANTHROPIC_AUTH_TOKEN;

  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      dockerPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "rm" ]; then exit 0; fi',
        '{',
        '  echo "===CALL==="',
        '  for arg in "$@"; do printf "%s\\n" "$arg"; done',
        '} >> "$AGENTHUB_DOCKER_ARGS_LOG"',
        'printf "%s\\n" \'{"type":"result","subtype":"success","is_error":false}\'',
      ].join('\n'),
      'utf8',
    );
    chmodSync(dockerPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath || ''}`;
    process.env.AGENTHUB_DOCKER_ARGS_LOG = logPath;
    process.env.ANTHROPIC_AUTH_TOKEN = 'secret-token-for-test';

    await (new ClaudeCodeProcess() as any).start(
      'session-12345678',
      'prompt',
      'container-id',
      '/workspace',
      true,
      workDir,
      'message-one',
      undefined,
      'code-agent',
    );

    await waitForFile(logPath);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const args = readFileSync(logPath, 'utf8');
    assert.match(args, /\n-e\nANTHROPIC_AUTH_TOKEN\n/);
    assert.equal(existsSync(join(workDir, '_env.sh')), false);
    assert.equal(args.includes('secret-token-for-test'), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.AGENTHUB_DOCKER_ARGS_LOG;
    else process.env.AGENTHUB_DOCKER_ARGS_LOG = oldLog;
    if (oldToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = oldToken;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('ClaudeCodeProcess proxies mutating Trust OFF tool use and replays after allow', async () => {
  const { ClaudeCodeProcess } = await import('./ClaudeCodeProcess.js');
  const workDir = mkdtempSync(join(tmpdir(), 'agenthub-claude-permission-'));
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
        'if [ "$1" = "rm" ]; then exit 0; fi',
        '{',
        '  echo "===CALL==="',
        '  for arg in "$@"; do printf "%s\\n" "$arg"; done',
        '} >> "$AGENTHUB_DOCKER_ARGS_LOG"',
        'case " $* " in',
        '  *"--allowedTools Write"*)',
        '    printf "%s\\n" \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/workspace/allow.txt","content":"ok"}}]}}\'',
        '    printf "%s\\n" \'{"type":"assistant","message":{"content":[{"type":"text","text":"allowed write complete"}]}}\'',
        '    printf "%s\\n" \'{"type":"result","subtype":"success","is_error":false}\'',
        '    ;;',
        '  *)',
        '    printf "%s\\n" \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/workspace/allow.txt","content":"ok"}}]}}\'',
        '    ;;',
        'esac',
      ].join('\n'),
      'utf8',
    );
    chmodSync(dockerPath, 0o755);
    process.env.PATH = `${fakeBin}:${oldPath || ''}`;
    process.env.AGENTHUB_DOCKER_ARGS_LOG = logPath;

    const proc = new ClaudeCodeProcess();
    const events: any[] = [];
    proc.onEvent((event) => events.push(event));

    await proc.start(
      'session-12345678',
      'write prompt',
      'container-id',
      '/workspace',
      false,
      workDir,
      'message-one',
      undefined,
      'code-agent',
    );

    await waitForEvent(events, (event) => event.type === 'permission_request');
    assert.deepEqual(
      events.find((event) => event.type === 'permission_request'),
      { type: 'permission_request', tool: 'Write', path: '/workspace/allow.txt' },
    );
    assert.equal(events.some((event) => event.type === 'done'), false);

    proc.write('y\n');
    await waitForEvent(events, (event) => event.type === 'done');

    assert.ok(events.some((event) => event.type === 'text' && event.content.includes('allowed write complete')));
    const calls = readFileSync(logPath, 'utf8').split('===CALL===').filter((call) => call.trim());
    assert.equal(calls.length, 2, 'initial run and allow replay are invoked');
    assert.ok(calls.at(-1)?.includes('--allowedTools'));
    assert.ok(calls.at(-1)?.includes('Write'));
    assert.equal(calls.at(-1)?.includes('--dangerously-skip-permissions'), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.AGENTHUB_DOCKER_ARGS_LOG;
    else process.env.AGENTHUB_DOCKER_ARGS_LOG = oldLog;
    rmSync(workDir, { recursive: true, force: true });
  }
});

async function waitForEvent(events: any[], predicate: (event: any) => boolean): Promise<void> {
  const started = Date.now();
  while (!events.some(predicate)) {
    if (Date.now() - started > 1000) throw new Error('Timed out waiting for event');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
