import { useEffect, useMemo, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { Check, X } from 'lucide-react';

export interface DiffHunk {
  id: string;
  header: string;
  lines: string[];
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
}

interface Props {
  path: string;
  diff: string;
  hunks?: DiffHunk[];
  conflictRanges?: { start: number; end: number }[];
  busyHunkId?: string | null;
  onAcceptHunk?: (hunkId: string) => void;
  onRejectHunk?: (hunkId: string) => void;
}

export function DiffViewer({ path, diff, hunks = [], conflictRanges = [], busyHunkId, onAcceptHunk, onRejectHunk }: Props) {
  const { original, modified, language } = useMemo(() => buildDiffModels(path, diff), [path, diff]);
  const [selectedHunkId, setSelectedHunkId] = useState(hunks[0]?.id ?? null);

  useEffect(() => {
    if (!selectedHunkId || !hunks.some((hunk) => hunk.id === selectedHunkId)) {
      setSelectedHunkId(hunks[0]?.id ?? null);
    }
  }, [hunks, selectedHunkId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || !selectedHunkId) return;
      const key = event.key.toLowerCase();
      if (key === 'a' && onAcceptHunk) {
        event.preventDefault();
        onAcceptHunk(selectedHunkId);
      }
      if (key === 'r' && onRejectHunk) {
        event.preventDefault();
        onRejectHunk(selectedHunkId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedHunkId, onAcceptHunk, onRejectHunk]);

  return (
    <div className="overflow-hidden rounded-md border border-hub bg-hub-code/60">
      <div className="flex items-center justify-between border-b border-hub px-3 py-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-hub-secondary">{path}</div>
          <div className="text-[11px] text-hub-muted">{hunks.length} hunks</div>
        </div>
      </div>
      {hunks.length > 0 && (
        <div className="max-h-28 overflow-y-auto border-b border-hub px-2 py-1">
          {hunks.map((hunk) => {
            const conflicts = hunkConflicts(hunk, conflictRanges);
            return (
              <div
                key={hunk.id}
                onClick={() => setSelectedHunkId(hunk.id)}
                className={`flex items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-hub-hover ${
                  selectedHunkId === hunk.id ? 'bg-sky-500/10 ring-1 ring-sky-500/30' : ''
                } ${conflicts ? 'bg-amber-500/10 text-amber-100' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-hub-muted">{hunk.header}</span>
                {onAcceptHunk && (
                  <button
                    onClick={() => onAcceptHunk(hunk.id)}
                    disabled={busyHunkId === hunk.id}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-emerald-300 hover:bg-emerald-500/15"
                    title="Accept hunk (Alt+A)"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                )}
                {onRejectHunk && (
                  <button
                    onClick={() => onRejectHunk(hunk.id)}
                    disabled={busyHunkId === hunk.id}
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-red-300 hover:bg-red-500/15"
                    title="Reject hunk (Alt+R)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <DiffEditor
        key={`${path}-${original.length}-${modified.length}`}
        height="360px"
        language={language}
        original={original}
        modified={modified}
        theme="vs-dark"
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
      />
    </div>
  );
}

function hunkConflicts(hunk: DiffHunk, ranges: { start: number; end: number }[]): boolean {
  if (!hunk.oldStart || ranges.length === 0) return false;
  const start = hunk.oldStart;
  const end = hunk.oldStart + Math.max(hunk.oldLines ?? 1, 1) - 1;
  return ranges.some((range) => start <= range.end && range.start <= end);
}

function buildDiffModels(path: string, diff: string): { original: string; modified: string; language: string } {
  const original: string[] = [];
  const modified: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    const marker = line[0];
    const body = line.slice(1);
    if (marker === '-') original.push(body);
    else if (marker === '+') modified.push(body);
    else if (marker === ' ') {
      original.push(body);
      modified.push(body);
    }
  }
  return {
    original: original.join('\n'),
    modified: modified.join('\n'),
    language: languageForPath(path),
  };
}

function languageForPath(path: string): string {
  if (/\.(tsx|ts)$/.test(path)) return 'typescript';
  if (/\.(jsx|js)$/.test(path)) return 'javascript';
  if (/\.json$/.test(path)) return 'json';
  if (/\.css$/.test(path)) return 'css';
  if (/\.md$/.test(path)) return 'markdown';
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (/\.html$/.test(path)) return 'html';
  return 'plaintext';
}
