import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { tmpdir } from 'os';

export interface Snapshot {
  /** git stash ref or branch name */
  ref: string;
  /** snapshot type */
  mode: 'stash' | 'branch';
  /** workspace path */
  workspacePath: string;
  /** timestamp */
  createdAt: number;
}

export interface WorkspaceVersion {
  id: string;
  ref: string;
  workspacePath: string;
  sessionId: string;
  agentName: string;
  summary: string;
  files: string[];
  createdAt: number;
}

export interface DiffHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

export interface FileDiff {
  path: string;
  baseRef?: string;
  headRef?: string;
  diff: string;
  hunks: DiffHunk[];
}

export interface AgentFileDiff {
  agentName: string;
  filePath: string;
  diff: string;
}

export interface FileConflict {
  filePath: string;
  agents: string[];
  ranges: { start: number; end: number }[];
}

export interface MergeResult {
  filePath: string;
  resolved: boolean;
  agents: string[];
}

export class WorkspaceManager {
  /**
   * Create a git snapshot before agent execution.
   * Uses git stash create for lightweight snapshot (no dangling commit).
   * Falls back to branch mode if stash fails.
   */
  static snapshot(workspacePath: string, sessionId: string): Snapshot | null {
    const absPath = resolve(workspacePath);
    if (!existsSync(resolve(absPath, '.git'))) {
      console.log(`[workspace] No git repo at ${absPath}, skipping snapshot`);
      return null;
    }

    try {
      // git stash create returns a commit SHA without modifying working tree or index
      const ref = execSync('git stash create', {
        cwd: absPath, encoding: 'utf8', timeout: 10000,
      }).trim();

      if (ref) {
        console.log(`[workspace] Stash snapshot created: ${ref.slice(0, 8)}`);
        return { ref, mode: 'stash', workspacePath: absPath, createdAt: Date.now() };
      }

      // No changes to snapshot — clean working tree
      console.log(`[workspace] Clean working tree, no snapshot needed`);
      return null;
    } catch (err: any) {
      console.log(`[workspace] Stash snapshot failed: ${err.message?.slice(0, 100)}`);
      // Attempt branch fallback
      try {
        const branchName = `agenthub-snapshot-${sessionId.slice(0, 8)}-${Date.now()}`;
        execSync(`git checkout -b ${branchName}`, { cwd: absPath, encoding: 'utf8', timeout: 10000 });
        execSync(`git checkout -`, { cwd: absPath, encoding: 'utf8', timeout: 10000 });
        console.log(`[workspace] Branch snapshot created: ${branchName}`);
        return { ref: branchName, mode: 'branch', workspacePath: absPath, createdAt: Date.now() };
      } catch (branchErr: any) {
        console.error(`[workspace] Branch snapshot also failed: ${branchErr.message?.slice(0, 100)}`);
        return null;
      }
    }
  }

  /** Rollback workspace to a previous snapshot */
  static rollback(snapshot: Snapshot): boolean {
    if (snapshot.mode === 'stash') {
      try {
        execSync(`git stash apply ${snapshot.ref}`, {
          cwd: snapshot.workspacePath, encoding: 'utf8', timeout: 15000,
        });
        console.log(`[workspace] Rolled back to stash ${snapshot.ref.slice(0, 8)}`);
        return true;
      } catch (err: any) {
        console.error(`[workspace] Stash rollback failed: ${err.message?.slice(0, 100)}`);
        return false;
      }
    }

    if (snapshot.mode === 'branch') {
      try {
        execSync(`git checkout ${snapshot.ref}`, {
          cwd: snapshot.workspacePath, encoding: 'utf8', timeout: 15000,
        });
        console.log(`[workspace] Rolled back to branch ${snapshot.ref}`);
        return true;
      } catch (err: any) {
        console.error(`[workspace] Branch rollback failed: ${err.message?.slice(0, 100)}`);
        return false;
      }
    }

    return false;
  }

  /** Get the current git diff summary (files changed) */
  static getChanges(workspacePath: string): string[] {
    const absPath = resolve(workspacePath);
    if (!existsSync(resolve(absPath, '.git'))) return [];

    try {
      const out = execSync('git diff --name-only', {
        cwd: absPath, encoding: 'utf8', timeout: 5000,
      }).trim();
      return out ? out.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  static recordVersion(
    workspacePath: string,
    input: { sessionId: string; agentName: string; summary: string },
  ): WorkspaceVersion {
    const absPath = resolve(workspacePath);
    ensureGitRepo(absPath);

    const { ref, files } = createTreeRef(absPath);
    const version: WorkspaceVersion = {
      id: `ver-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ref,
      workspacePath: absPath,
      sessionId: input.sessionId,
      agentName: input.agentName,
      summary: input.summary,
      files,
      createdAt: Date.now(),
    };

    const versions = readVersions(absPath);
    versions.push(version);
    writeVersions(absPath, versions);
    return version;
  }

  static listVersions(workspacePath: string): WorkspaceVersion[] {
    return readVersions(resolve(workspacePath));
  }

  static getFileDiff(workspacePath: string, filePath: string, baseVersionId?: string): FileDiff {
    const absPath = resolve(workspacePath);
    assertGitRepo(absPath);
    const normalizedPath = normalizeWorkspacePath(absPath, filePath);
    const baseRef = baseVersionId
      ? findVersion(absPath, baseVersionId).ref
      : 'HEAD';
    const diff = runGit(absPath, ['diff', '--no-ext-diff', '--unified=3', baseRef, '--', normalizedPath], false);
    return {
      path: normalizedPath,
      baseRef,
      diff,
      hunks: parseDiffHunks(diff),
    };
  }

  static getWorkspaceDiff(workspacePath: string, baseVersionId?: string): FileDiff[] {
    const absPath = resolve(workspacePath);
    assertGitRepo(absPath);
    const baseRef = baseVersionId
      ? findVersion(absPath, baseVersionId).ref
      : 'HEAD';
    const tracked = runGit(absPath, ['diff', '--name-only', baseRef], false).split('\n').filter(isUserWorkspacePath);
    const untracked = runGit(absPath, ['ls-files', '--others', '--exclude-standard'], false).split('\n').filter(isUserWorkspacePath);
    const files = [...new Set([...tracked, ...untracked])];
    return files.map((filePath) => {
      if (untracked.includes(filePath) && !tracked.includes(filePath)) {
        return buildUntrackedFileDiff(absPath, filePath);
      }
      return this.getFileDiff(absPath, filePath, baseVersionId);
    });
  }

  static diffVersions(workspacePath: string, fromVersionId: string, toVersionId: string, filePath?: string): FileDiff {
    const absPath = resolve(workspacePath);
    assertGitRepo(absPath);
    const from = findVersion(absPath, fromVersionId);
    const to = findVersion(absPath, toVersionId);
    const args = ['diff', '--no-ext-diff', '--unified=3', from.ref, to.ref];
    const normalizedPath = filePath ? normalizeWorkspacePath(absPath, filePath) : '';
    if (normalizedPath) args.push('--', normalizedPath);
    const diff = runGit(absPath, args, false);
    return {
      path: normalizedPath,
      baseRef: from.ref,
      headRef: to.ref,
      diff,
      hunks: parseDiffHunks(diff),
    };
  }

  /** Diff between two version refs, returning per-file diffs (for conflict detection). */
  static diffBetweenVersions(workspacePath: string, fromVersionId: string, toVersionId: string): FileDiff[] {
    const absPath = resolve(workspacePath);
    assertGitRepo(absPath);
    const from = findVersion(absPath, fromVersionId);
    const to = findVersion(absPath, toVersionId);
    const changedFiles = runGit(absPath, ['diff', '--name-only', from.ref, to.ref], false)
      .split('\n').filter(isUserWorkspacePath);
    return changedFiles.map((filePath) => {
      const diff = runGit(absPath, ['diff', '--no-ext-diff', '--unified=3', from.ref, to.ref, '--', filePath], false);
      return {
        path: filePath,
        baseRef: from.ref,
        headRef: to.ref,
        diff,
        hunks: parseDiffHunks(diff),
      };
    });
  }

  static restoreVersion(workspacePath: string, versionId: string): boolean {
    const absPath = resolve(workspacePath);
    assertGitRepo(absPath);
    const version = findVersion(absPath, versionId);
    try {
      runGit(absPath, ['checkout', version.ref, '--', '.']);
      return true;
    } catch (err: any) {
      console.error(`[workspace] restoreVersion failed: ${err.message?.slice(0, 120)}`);
      return false;
    }
  }

  static acceptFileChanges(workspacePath: string, filePath: string): boolean {
    const absPath = resolve(workspacePath);
    assertGitRepo(absPath);
    const normalizedPath = normalizeWorkspacePath(absPath, filePath);
    try {
      runGit(absPath, ['add', '--', normalizedPath]);
      return true;
    } catch (err: any) {
      console.error(`[workspace] acceptFileChanges failed: ${err.message?.slice(0, 120)}`);
      return false;
    }
  }

  static rejectFileChanges(workspacePath: string, filePath: string, baseVersionId?: string): boolean {
    const absPath = resolve(workspacePath);
    assertGitRepo(absPath);
    const normalizedPath = normalizeWorkspacePath(absPath, filePath);
    const baseRef = baseVersionId ? findVersion(absPath, baseVersionId).ref : 'HEAD';
    try {
      if (pathExistsInRef(absPath, baseRef, normalizedPath)) {
        runGit(absPath, ['checkout', baseRef, '--', normalizedPath]);
      } else if (existsSync(resolve(absPath, normalizedPath))) {
        rmSync(resolve(absPath, normalizedPath), { recursive: true, force: true });
      }
      return true;
    } catch (err: any) {
      console.error(`[workspace] rejectFileChanges failed: ${err.message?.slice(0, 120)}`);
      return false;
    }
  }

  /** Export a file's content from a specific version by ref */
  static getFileAtVersion(workspacePath: string, ref: string, filePath: string): string | null {
    const absPath = resolve(workspacePath);
    try {
      return runGit(absPath, ['show', `${ref}:${filePath}`]);
    } catch {
      return null;
    }
  }

  /**
   * Attempt 3-way git merge for a file modified by two agents.
   * Returns the merged content if successful, null if merge conflicts exist.
   */
  static tryAutoMergeFile(
    workspacePath: string,
    filePath: string,
    baseContent: string,
    oursContent: string,
    theirsContent: string,
  ): { resolved: boolean; content: string } {
    const absPath = resolve(workspacePath);
    const tmpPrefix = resolve(tmpdir(), `agenthub-merge-${Date.now()}`);
    const baseFile = `${tmpPrefix}-base`;
    const oursFile = `${tmpPrefix}-ours`;
    const theirsFile = `${tmpPrefix}-theirs`;

    try {
      writeFileSync(baseFile, baseContent, 'utf8');
      writeFileSync(oursFile, oursContent, 'utf8');
      writeFileSync(theirsFile, theirsContent, 'utf8');

      // git merge-file: ours base theirs → writes merged result into ours
      execFileSync('git', ['merge-file', oursFile, baseFile, theirsFile], {
        timeout: 10000,
        stdio: 'pipe',
      });

      const merged = readFileSync(oursFile, 'utf8');
      return { resolved: true, content: merged };
    } catch (err: any) {
      // git merge-file returns non-zero when there are conflicts
      // The file still contains conflict markers we can use
      if (err.status && err.status > 0) {
        try {
          const conflicted = readFileSync(oursFile, 'utf8');
          return { resolved: false, content: conflicted };
        } catch {
          // file unreadable — fall through to return original oursContent
        }
      }
      console.error(`[workspace] auto-merge failed for ${filePath}: ${err.message?.slice(0, 120)}`);
      return { resolved: false, content: oursContent };
    } finally {
      // Clean up temp files
      [baseFile, oursFile, theirsFile].forEach((f) => {
        try { unlinkSync(f); } catch { /* ignore */ }
      });
    }
  }

  /**
   * Attempt auto-merge for all detected conflicts.
   * Uses 3-way git merge with the earliest agent's before-version as base.
   */
  static tryAutoMerge(
    workspacePath: string,
    conflicts: FileConflict[],
    commonBaseRef: string,
    agentRefs: Map<string, string>,
  ): MergeResult[] {
    const absPath = resolve(workspacePath);
    const results: MergeResult[] = [];

    for (const conflict of conflicts) {
      const agentList = conflict.agents.slice(0, 2); // merge pairwise
      if (agentList.length < 2) { results.push({ filePath: conflict.filePath, resolved: true, agents: agentList }); continue; }

      const baseContent = WorkspaceManager.getFileAtVersion(absPath, commonBaseRef, conflict.filePath);
      if (baseContent === null) { results.push({ filePath: conflict.filePath, resolved: false, agents: agentList }); continue; }

      const oursContent = WorkspaceManager.getFileAtVersion(absPath, agentRefs.get(agentList[0]) ?? commonBaseRef, conflict.filePath);
      const theirsContent = WorkspaceManager.getFileAtVersion(absPath, agentRefs.get(agentList[1]) ?? commonBaseRef, conflict.filePath);
      if (oursContent === null || theirsContent === null) { results.push({ filePath: conflict.filePath, resolved: false, agents: agentList }); continue; }

      const mergeResult = WorkspaceManager.tryAutoMergeFile(absPath, conflict.filePath, baseContent, oursContent, theirsContent);

      if (mergeResult.resolved) {
        // Write merged content back to workspace
        try {
          writeFileSync(resolve(absPath, conflict.filePath), mergeResult.content, 'utf8');
          runGit(absPath, ['add', '--', conflict.filePath]);
        } catch (err: any) {
          console.error(`[workspace] failed to write merged ${conflict.filePath}: ${err.message?.slice(0, 120)}`);
        }
      }

      results.push({
        filePath: conflict.filePath,
        resolved: mergeResult.resolved,
        agents: agentList,
      });
    }

    return results;
  }

  static detectConflicts(diffs: AgentFileDiff[]): FileConflict[] {
    const byFile = new Map<string, { agentName: string; ranges: { start: number; end: number }[] }[]>();
    for (const item of diffs) {
      const ranges = parseDiffHunks(item.diff).map((hunk) => ({
        start: hunk.oldStart,
        end: hunk.oldStart + Math.max(hunk.oldLines, 1) - 1,
      }));
      const existing = byFile.get(item.filePath) ?? [];
      existing.push({ agentName: item.agentName, ranges });
      byFile.set(item.filePath, existing);
    }

    const conflicts: FileConflict[] = [];
    for (const [filePath, entries] of byFile) {
      const agents = new Set<string>();
      const ranges: { start: number; end: number }[] = [];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          for (const left of entries[i].ranges) {
            for (const right of entries[j].ranges) {
              if (rangesOverlap(left, right)) {
                agents.add(entries[i].agentName);
                agents.add(entries[j].agentName);
                ranges.push({
                  start: Math.max(left.start, right.start),
                  end: Math.min(left.end, right.end),
                });
              }
            }
          }
        }
      }
      if (agents.size > 1) conflicts.push({ filePath, agents: [...agents], ranges });
    }
    return conflicts;
  }
}

function assertGitRepo(absPath: string): void {
  if (!existsSync(resolve(absPath, '.git'))) {
    throw new Error(`No git repository at ${absPath}`);
  }
}

function ensureGitRepo(absPath: string): void {
  mkdirSync(absPath, { recursive: true });
  if (existsSync(resolve(absPath, '.git'))) return;
  execFileSync('git', ['init'], { cwd: absPath, stdio: 'ignore', timeout: 15000 });
  execFileSync('git', ['config', 'user.email', 'agenthub@example.local'], { cwd: absPath, stdio: 'ignore', timeout: 15000 });
  execFileSync('git', ['config', 'user.name', 'AgentHub'], { cwd: absPath, stdio: 'ignore', timeout: 15000 });
  // Write .gitignore to prevent agent-internal files from being tracked
  writeFileSync(resolve(absPath, '.gitignore'), [
    '# AgentHub — agent internal files (never track)',
    '_agent_*/',
    '_prompt_*',
    '_repl_prompt_*',
    '_env*',
    '_inbox_*',
    '_comm_*',
    '.agenthub/',
    '.claude/',
    '',
  ].join('\n'), 'utf8');
  execFileSync('git', ['add', '.gitignore'], { cwd: absPath, stdio: 'ignore', timeout: 15000 });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'AgentHub baseline'], { cwd: absPath, stdio: 'ignore', timeout: 15000 });
}

function createTreeRef(absPath: string): { ref: string; files: string[] } {
  const files = listWorkspaceChanges(absPath);
  if (files.length === 0) {
    return { ref: runGit(absPath, ['rev-parse', 'HEAD']).trim(), files: [] };
  }

  const agentHubDir = resolve(absPath, '.agenthub');
  mkdirSync(agentHubDir, { recursive: true });
  const indexFile = resolve(agentHubDir, `index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const head = runGit(absPath, ['rev-parse', 'HEAD']).trim();
    runGit(absPath, ['read-tree', head], true, env);
    for (const file of files) {
      if (existsSync(resolve(absPath, file))) runGit(absPath, ['add', '--', file], true, env);
      else runGit(absPath, ['rm', '--cached', '--ignore-unmatch', '--', file], true, env);
    }
    const tree = runGit(absPath, ['write-tree'], true, env).trim();
    const ref = runGitWithInput(absPath, ['commit-tree', tree, '-p', head], 'AgentHub version snapshot\n', env).trim();
    return { ref, files };
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function listChangedFiles(absPath: string, ref: string): string[] {
  const parent = runGit(absPath, ['rev-list', '--parents', '-n', '1', ref], false).trim().split(/\s+/)[1];
  if (!parent) return [];
  return runGit(absPath, ['diff', '--name-only', parent, ref], false).split('\n').filter(isUserWorkspacePath);
}

function listWorkspaceChanges(absPath: string): string[] {
  const unstaged = runGit(absPath, ['diff', '--name-only'], false).split('\n');
  const staged = runGit(absPath, ['diff', '--cached', '--name-only'], false).split('\n');
  const untracked = runGit(absPath, ['ls-files', '--others', '--exclude-standard'], false).split('\n');
  return [...new Set([...unstaged, ...staged, ...untracked].filter(isUserWorkspacePath))];
}

/** Directories whose contents are agent-internal and should never appear in diffs */
const INTERNAL_DIRS = new Set(['.agenthub', '.git', 'node_modules', '.claude', '_agent_', '.sandboxes']);

/** File prefixes that indicate agent-internal files (prompts, env, inter-agent comms) */
const INTERNAL_PREFIXES = ['_prompt_', '_repl_prompt_', '_env', '_inbox_', '_comm_'];

function isUserWorkspacePath(filePath: string): boolean {
  if (!filePath) return false;
  // Exclude entire directories of agent-internal files
  const topDir = filePath.split('/')[0];
  if (INTERNAL_DIRS.has(topDir)) return false;
  // Exclude per-agent working directories (_agent_code-agent/, _agent_planner/, etc.)
  if (topDir.startsWith('_agent_')) return false;
  // Exclude agent-internal file prefixes
  const fileName = filePath.split('/').pop() ?? '';
  if (INTERNAL_PREFIXES.some((prefix) => fileName.startsWith(prefix))) return false;
  return true;
}

function runGit(absPath: string, args: string[], throwOnError = true, env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', args, { cwd: absPath, encoding: 'utf8', timeout: 15000, env });
  } catch (err) {
    if (throwOnError) throw err;
    return '';
  }
}

function runGitWithInput(absPath: string, args: string[], input: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd: absPath, encoding: 'utf8', timeout: 15000, input, env });
}

function metadataPath(absPath: string): string {
  return resolve(absPath, '.agenthub', 'versions.json');
}

function readVersions(absPath: string): WorkspaceVersion[] {
  const file = metadataPath(absPath);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as WorkspaceVersion[];
  } catch {
    return [];
  }
}

function writeVersions(absPath: string, versions: WorkspaceVersion[]): void {
  const file = metadataPath(absPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(versions, null, 2), 'utf8');
}

function findVersion(absPath: string, versionId: string): WorkspaceVersion {
  const version = readVersions(absPath).find((item) => item.id === versionId);
  if (!version) throw new Error(`Version not found: ${versionId}`);
  return version;
}

function normalizeWorkspacePath(workspacePath: string, filePath: string): string {
  const withoutWorkspace = filePath.replace(/^\/workspace\/?/, '');
  const absFile = resolve(workspacePath, withoutWorkspace);
  const relPath = relative(workspacePath, absFile);
  if (!relPath || relPath.startsWith('..') || relPath.startsWith('/')) {
    throw new Error('Path traversal denied');
  }
  return relPath;
}

function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diff.split('\n');
  let current: DiffHunk | null = null;
  for (const line of lines) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (match) {
      const oldStart = Number(match[1]);
      const oldLines = Number(match[2] ?? '1');
      const newStart = Number(match[3]);
      const newLines = Number(match[4] ?? '1');
      current = {
        id: `hunk-${hunks.length}-${oldStart}-${oldLines}-${newStart}-${newLines}`,
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: line,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return hunks;
}

function rangesOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function pathExistsInRef(absPath: string, ref: string, filePath: string): boolean {
  try {
    runGit(absPath, ['cat-file', '-e', `${ref}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

function buildUntrackedFileDiff(absPath: string, filePath: string): FileDiff {
  const content = readFileSync(resolve(absPath, filePath), 'utf8');
  const lines = content.split('\n');
  const diffLines = [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    ...lines.map((line) => `+${line}`),
  ];
  const diff = diffLines.join('\n');
  return { path: filePath, diff, hunks: parseDiffHunks(diff) };
}
