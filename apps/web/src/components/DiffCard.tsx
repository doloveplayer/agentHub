import { useState } from 'react';
import { ChevronDown, ChevronRight, GitPullRequest, Check, X } from 'lucide-react';
import { api } from '../lib/api';
import { DiffViewer } from './DiffViewer';

export interface DiffFile {
  path: string;
  diff: string;
  hunks: { id: string; header: string; lines: string[]; oldStart?: number; oldLines?: number; newStart?: number; newLines?: number }[];
  baseVersionId?: string;
  conflict?: { filePath: string; agents: string[]; ranges: { start: number; end: number }[] };
}

interface Props {
  sessionId: string;
  files: DiffFile[];
  title?: string;
}

export function DiffCard({ sessionId, files, title = 'File changes' }: Props) {
  const [expandedPath, setExpandedPath] = useState(files[0]?.path ?? '');
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [busyHunk, setBusyHunk] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [dismissedHunks, setDismissedHunks] = useState<Set<string>>(() => new Set());

  const visibleFiles = files.filter((file) => !dismissed.has(file.path));
  if (visibleFiles.length === 0) return null;

  const acceptFile = async (file: DiffFile) => {
    setBusyPath(file.path);
    try {
      await api.acceptDiffFile(sessionId, file.path);
      setDismissed((prev) => new Set(prev).add(file.path));
    } finally {
      setBusyPath(null);
    }
  };

  const rejectFile = async (file: DiffFile) => {
    setBusyPath(file.path);
    try {
      await api.rejectDiffFile(sessionId, file.path, file.baseVersionId);
      setDismissed((prev) => new Set(prev).add(file.path));
    } finally {
      setBusyPath(null);
    }
  };

  const acceptHunk = async (file: DiffFile, hunkId: string) => {
    setBusyHunk(`${file.path}:${hunkId}`);
    try {
      await api.acceptDiffHunk(sessionId, file.path, hunkId, file.baseVersionId);
      setDismissedHunks((prev) => new Set(prev).add(`${file.path}:${hunkId}`));
    } finally {
      setBusyHunk(null);
    }
  };

  const rejectHunk = async (file: DiffFile, hunkId: string) => {
    setBusyHunk(`${file.path}:${hunkId}`);
    try {
      await api.rejectDiffHunk(sessionId, file.path, hunkId, file.baseVersionId);
      setDismissedHunks((prev) => new Set(prev).add(`${file.path}:${hunkId}`));
    } finally {
      setBusyHunk(null);
    }
  };

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-xl border border-sky-700/40 bg-slate-900/90">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <GitPullRequest className="h-4 w-4 text-sky-300" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <div className="text-xs text-slate-500">{visibleFiles.length} changed files</div>
        </div>
      </div>
      <div className="divide-y divide-white/10">
        {visibleFiles.map((file) => {
          const expanded = expandedPath === file.path;
          return (
            <div key={file.path}>
              <div className={`flex items-center gap-2 px-4 py-2 ${file.conflict ? 'bg-amber-500/10' : ''}`}>
                <button
                  onClick={() => setExpandedPath(expanded ? '' : file.path)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/10"
                  title={expanded ? 'Collapse diff' : 'Expand diff'}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-300">{file.path}</span>
                {file.conflict && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-200">
                    conflict: {file.conflict.agents.join(', ')}
                  </span>
                )}
                <span className="text-[11px] text-slate-500">{file.hunks.length} hunks</span>
                <button
                  onClick={() => acceptFile(file)}
                  disabled={busyPath === file.path}
                  className="inline-flex h-7 items-center gap-1 rounded bg-emerald-600/15 px-2 text-xs text-emerald-300 hover:bg-emerald-600/25 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" /> Accept
                </button>
                <button
                  onClick={() => rejectFile(file)}
                  disabled={busyPath === file.path}
                  className="inline-flex h-7 items-center gap-1 rounded bg-red-600/15 px-2 text-xs text-red-300 hover:bg-red-600/25 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </button>
              </div>
              {expanded && (
                <div className="px-3 pb-3">
                  <DiffViewer
                    path={file.path}
                    diff={file.diff}
                    hunks={file.hunks.filter((hunk) => !dismissedHunks.has(`${file.path}:${hunk.id}`))}
                    conflictRanges={file.conflict?.ranges}
                    busyHunkId={busyHunk?.startsWith(`${file.path}:`) ? busyHunk.slice(file.path.length + 1) : null}
                    onAcceptHunk={(hunkId) => acceptHunk(file, hunkId)}
                    onRejectHunk={(hunkId) => rejectHunk(file, hunkId)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
