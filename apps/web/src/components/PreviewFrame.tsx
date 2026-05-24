import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCcw } from 'lucide-react';
import { api } from '../lib/api';
import { ScreenshotComparisonCard } from './ScreenshotComparisonCard';

interface Props {
  sessionId: string;
}

/** Inline preview component for embedding inside panel tabs or message cards */
export function PreviewFrame({ sessionId }: Props) {
  const [ports, setPorts] = useState<number[]>([]);
  const [port, setPort] = useState<number>(5173);
  const [url, setUrl] = useState('');
  const [directUrl, setDirectUrl] = useState('');
  const [beforeShot, setBeforeShot] = useState('');
  const [afterShot, setAfterShot] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshPorts = async () => {
    setLoading(true);
    try {
      const result = await api.getPreviewPorts(sessionId);
      setPorts(result.ports);
      if (result.ports[0]) setPort(result.ports[0]);
    } finally {
      setLoading(false);
    }
  };

  const openPreview = async () => {
    setLoading(true);
    try {
      const result = await api.forwardPreviewPort(sessionId, port);
      setUrl(result.proxyUrl || result.url);
      setDirectUrl(result.url);
    } finally {
      setLoading(false);
    }
  };

  const capture = async (slot: 'before' | 'after') => {
    if (!directUrl) return;
    const result = await api.capturePreviewScreenshot(sessionId, directUrl);
    if (slot === 'before') setBeforeShot(result.image);
    else setAfterShot(result.image);
  };

  useEffect(() => {
    let cancelled = false;
    const tryPorts = async (attempt: number) => {
      try {
        const result = await api.getPreviewPorts(sessionId);
        if (cancelled) return;
        setPorts(result.ports);
        if (result.ports[0]) setPort(result.ports[0]);
      } catch {
        if (cancelled) return;
        if (attempt < 2) {
          setTimeout(() => tryPorts(attempt + 1), (attempt + 1) * 1000);
        }
      }
    };
    tryPorts(0);
    return () => { cancelled = true; };
  }, [sessionId]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <select
          value={port}
          onChange={(event) => setPort(Number(event.target.value))}
          className="h-8 rounded border border-white/10 bg-slate-900 px-2 text-xs text-slate-200"
        >
          {[...new Set([port, ...ports])].map((item) => (
            <option key={item} value={item}>:{item}</option>
          ))}
        </select>
        <button
          onClick={refreshPorts}
          disabled={loading}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:bg-white/10 disabled:opacity-50"
          title="Detect ports"
        >
          <RefreshCcw className="h-4 w-4" />
        </button>
        <button
          onClick={openPreview}
          disabled={loading}
          className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          Open
        </button>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:bg-white/10"
            title="Open in new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        {url && (
          <>
            <button onClick={() => capture('before')} className="rounded px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10">Before</button>
            <button onClick={() => capture('after')} className="rounded px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10">After</button>
          </>
        )}
      </div>
      {url ? (
        <iframe
          key={`${url}-${refreshKey}`}
          src={url}
          className="min-h-0 flex-1 bg-white"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-slate-500 px-4 text-center">
          Select a port and click Open to preview.
        </div>
      )}
      {url && (
        <button
          onClick={() => setRefreshKey((value) => value + 1)}
          className="border-t border-white/10 py-1 text-[11px] text-slate-400 hover:bg-white/5"
        >
          Reload preview
        </button>
      )}
      <ScreenshotComparisonCard before={beforeShot} after={afterShot} />
    </div>
  );
}
