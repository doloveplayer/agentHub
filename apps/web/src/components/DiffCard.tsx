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
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [dismissedFiles, setDismissedFiles] = useState<Set<string>>(() => new Set());
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const visibleFiles = files.filter((file) => !dismissedFiles.has(file.path));
  if (visibleFiles.length === 0) return null;

  const acceptFile = async (file: DiffFile) => {
    setBusyPath(file.path);
    try {
      await api.acceptDiffFile(sessionId, file.path);
      setDismissedFiles((prev) => new Set(prev).add(file.path));
    } finally {
      setBusyPath(null);
    }
  };

  const rejectFile = async (file: DiffFile) => {
    setBusyPath(file.path);
    try {
      await api.rejectDiffFile(sessionId, file.path, file.baseVersionId);
      setDismissedFiles((prev) => new Set(prev).add(file.path));
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-hub-lg border border-hub bg-hub-surface">
      <div className="flex items-center gap-2 border-b border-hub px-4 py-3">
        <GitPullRequest className="h-4 w-4 text-hub-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-hub-primary">{title}</div>
          <div className="text-xs text-hub-tertiary">{visibleFiles.length} changed file{visibleFiles.length === 1 ? '' : 's'}</div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover hover:text-hub-secondary"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="divide-y divide-hub">
        {visibleFiles.map((file) => {
          const expanded = expandedPath === file.path;
          return (
            <div key={file.path}>
              <div className={`flex items-center gap-2 px-4 py-2 ${file.conflict ? 'bg-hub-warning/10' : ''}`}>
                <button
                  onClick={() => setExpandedPath(expanded ? null : file.path)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-hub-hover"
                  title={expanded ? 'Collapse diff' : 'Expand diff'}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-hub-secondary">{file.path}</span>
                {file.conflict && (
                  <span className="rounded bg-hub-warning/15 px-1.5 py-0.5 text-[11px] text-hub-warning">
                    conflict: {file.conflict.agents.join(', ')}
                  </span>
                )}
                <button
                  onClick={() => acceptFile(file)}
                  disabled={busyPath === file.path}
                  className="inline-flex h-7 items-center gap-1 rounded bg-hub-success/15 px-2 text-xs text-hub-success hover:bg-hub-success/25 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" /> Accept
                </button>
                <button
                  onClick={() => rejectFile(file)}
                  disabled={busyPath === file.path}
                  className="inline-flex h-7 items-center gap-1 rounded bg-hub-danger/15 px-2 text-xs text-hub-danger hover:bg-hub-danger/25 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Reject
                </button>
              </div>
              {expanded && (
                <div className="px-3 pb-3">
                  <DiffViewer
                    path={file.path}
                    diff={file.diff}
                    hunks={file.hunks}
                    conflictRanges={file.conflict?.ranges}
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
