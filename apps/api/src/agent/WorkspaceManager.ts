import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

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
}
