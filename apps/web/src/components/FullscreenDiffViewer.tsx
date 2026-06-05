import { useEffect, useMemo, useState } from 'react';
import { X, FileText } from 'lucide-react';
import { api } from '../lib/api';
import { DiffViewer } from './DiffViewer';

interface Props {
  sessionId: string;
  from: string;
  to: string;
  onClose: () => void;
}

interface FileDiffEntry {
  path: string;
  diff: string;
}

function parseMultiFileDiff(rawDiff: string): FileDiffEntry[] {
  const files: FileDiffEntry[] = [];
  const parts = rawDiff.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const match = part.match(/^diff --git a\/(.+?) b\/(.+)/m);
    if (match) {
      files.push({ path: match[2], diff: part });
    }
  }
  // If no diff --git markers, treat as single file
  if (files.length === 0 && rawDiff.trim()) {
    files.push({ path: 'workspace', diff: rawDiff });
  }
  return files;
}

export function FullscreenDiffViewer({ sessionId, from, to, onClose }: Props) {
  const [rawDiff, setRawDiff] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.diffVersions(sessionId, from, to)
      .then((data) => { if (!cancelled) setRawDiff(data.diff?.diff || ''); })
      .catch(() => { if (!cancelled) setRawDiff(''); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, from, to]);

  const files = useMemo(() => parseMultiFileDiff(rawDiff), [rawDiff]);
  const selected = files[selectedIdx];

  // Keep selectedIdx in bounds
  useEffect(() => {
    if (selectedIdx >= files.length) setSelectedIdx(0);
  }, [files.length, selectedIdx]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-hub px-4 py-2">
        <FileText className="h-4 w-4 text-hub-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-hub-primary">
            Version Comparison
          </div>
          <div className="text-[11px] text-hub-muted">
            {files.length} file{files.length !== 1 ? 's' : ''} changed
          </div>
        </div>
        <button
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-hub-tertiary hover:bg-hub-hover hover:text-hub-primary"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* File selector */}
      {files.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-hub px-3 py-1.5">
          {files.map((file, idx) => (
            <button
              key={file.path}
              onClick={() => setSelectedIdx(idx)}
              className={`shrink-0 rounded px-2 py-1 text-[11px] font-mono ${
                idx === selectedIdx
                  ? 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'
                  : 'text-hub-muted hover:bg-hub-hover hover:text-hub-secondary'
              }`}
            >
              {file.path}
            </button>
          ))}
        </div>
      )}

      {/* Diff content */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-hub-muted">
            Loading diff...
          </div>
        ) : selected ? (
          <DiffViewer path={selected.path} diff={selected.diff} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-hub-muted">
            No changes between selected versions
          </div>
        )}
      </div>
    </div>
  );
}
