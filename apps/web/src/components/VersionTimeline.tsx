import { useEffect, useState } from 'react';
import { Clock, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { DiffViewer } from './DiffViewer';

interface Version {
  id: string;
  agentName: string;
  summary: string;
  files: string[];
  createdAt: number;
}

interface Props {
  sessionId: string;
}

export function VersionTimeline({ sessionId }: Props) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [diff, setDiff] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    const data = await api.getVersions(sessionId).catch(() => ({ versions: [] }));
    setVersions(data.versions);
    if (!from && data.versions.length > 0) setFrom(data.versions[0].id);
    if (!to && data.versions.length > 1) setTo(data.versions[data.versions.length - 1].id);
  };

  useEffect(() => {
    if (sessionId) refresh();
  }, [sessionId]);

  const compare = async () => {
    if (!from || !to) return;
    setLoading(true);
    try {
      const data = await api.diffVersions(sessionId, from, to);
      setDiff(data.diff);
    } finally {
      setLoading(false);
    }
  };

  const restore = async (versionId: string) => {
    await api.restoreVersion(sessionId, versionId);
    await refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Version history</div>
        <button onClick={refresh} className="text-xs text-slate-500 hover:text-slate-300">Refresh</button>
      </div>
      {versions.length === 0 && (
        <div className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-500">No versions recorded yet</div>
      )}
      <div className="space-y-2">
        {versions.map((version) => (
          <div key={version.id} className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="flex items-start gap-2">
              <Clock className="mt-0.5 h-3.5 w-3.5 text-slate-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-slate-200">{version.summary}</div>
                <div className="text-[11px] text-slate-500">
                  {version.agentName} · {new Date(version.createdAt).toLocaleString()} · {version.files.length} files
                </div>
              </div>
              <button
                onClick={() => restore(version.id)}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-white/10 hover:text-slate-200"
                title="Restore this version"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {versions.length >= 2 && (
        <div className="space-y-2 rounded-md border border-white/10 p-2">
          <div className="grid grid-cols-2 gap-2">
            <select value={from} onChange={(e) => setFrom(e.target.value)} className="rounded bg-slate-950 px-2 py-1 text-xs text-slate-300">
              {versions.map((version) => <option key={version.id} value={version.id}>{version.summary}</option>)}
            </select>
            <select value={to} onChange={(e) => setTo(e.target.value)} className="rounded bg-slate-950 px-2 py-1 text-xs text-slate-300">
              {versions.map((version) => <option key={version.id} value={version.id}>{version.summary}</option>)}
            </select>
          </div>
          <button
            onClick={compare}
            disabled={loading || !from || !to}
            className="w-full rounded bg-sky-600/20 px-2 py-1 text-xs text-sky-300 hover:bg-sky-600/30 disabled:opacity-50"
          >
            Compare versions
          </button>
        </div>
      )}
      {diff && (
        <DiffViewer path={diff.path || 'workspace'} diff={diff.diff} hunks={diff.hunks} />
      )}
    </div>
  );
}
