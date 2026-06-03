import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, Globe, RefreshCcw } from 'lucide-react';
import { api } from '../lib/api';
import { ScreenshotComparisonCard } from './ScreenshotComparisonCard';

interface SelectionData {
  text: string;
  rect: { top: number; left: number; width: number; height: number };
  url: string;
}

interface Props {
  sessionId: string;
  onSelection?: (selection: SelectionData | null) => void;
}

/** Inline preview component for embedding inside panel tabs or message cards */
export function PreviewFrame({ sessionId, onSelection }: Props) {
  const [ports, setPorts] = useState<number[]>([]);
  const [port, setPort] = useState<number>(5175);
  const [url, setUrl] = useState('');
  const [directUrl, setDirectUrl] = useState('');
  const [beforeShot, setBeforeShot] = useState('');
  const [afterShot, setAfterShot] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [staticDir, setStaticDir] = useState('/workspace');
  const [serving, setServing] = useState(false);
  const [serveError, setServeError] = useState<string | null>(null);

  const serveStatic = async () => {
    setServing(true);
    setServeError(null);
    try {
      const result = await api.serveStaticDir(sessionId, staticDir);
      setUrl(result.proxyUrl);
      setDirectUrl(result.url);
    } catch (err: any) {
      setServeError(err?.message || 'Failed to start static server');
    } finally {
      setServing(false);
    }
  };

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

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'agenthub:selection') {
        onSelection?.(event.data as SelectionData);
      } else if (event.data?.type === 'agenthub:selection-clear') {
        onSelection?.(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onSelection]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-hub px-3 py-2">
        <select
          value={port}
          onChange={(event) => setPort(Number(event.target.value))}
          className="h-8 rounded border border-hub bg-hub-input px-2 text-xs text-hub-primary"
        >
          {[...new Set([port, ...ports])].map((item) => (
            <option key={item} value={item}>:{item}</option>
          ))}
        </select>
        <button
          onClick={refreshPorts}
          disabled={loading}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover disabled:opacity-50"
          title="Detect ports"
        >
          <RefreshCcw className="h-4 w-4" />
        </button>
        <button
          onClick={openPreview}
          disabled={loading}
          className="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-hub-primary hover:bg-sky-500 disabled:opacity-50"
        >
          Open
        </button>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 w-8 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover"
            title="Open in new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        {url && (
          <>
            <button onClick={() => capture('before')} className="rounded px-2 py-1 text-[11px] text-hub-secondary hover:bg-hub-hover">Before</button>
            <button onClick={() => capture('after')} className="rounded px-2 py-1 text-[11px] text-hub-secondary hover:bg-hub-hover">After</button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-hub px-3 py-2">
        <FolderOpen className="h-3.5 w-3.5 text-hub-tertiary shrink-0" />
        <input
          value={staticDir}
          onChange={(e) => setStaticDir(e.target.value)}
          placeholder="/workspace"
          className="h-8 flex-1 rounded border border-hub bg-hub-input px-2 text-xs text-hub-primary font-mono"
        />
        <button
          onClick={serveStatic}
          disabled={serving || !staticDir}
          className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50 shrink-0"
        >
          <Globe className="h-3.5 w-3.5" />
          {serving ? 'Starting...' : 'Serve'}
        </button>
      </div>
      {serveError && (
        <div className="border-b border-hub bg-hub-danger/10 px-3 py-2 text-xs text-hub-danger">{serveError}</div>
      )}
      {url ? (
        <iframe
          key={`${url}-${refreshKey}`}
          src={url}
          className="min-h-0 flex-1 bg-white"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-hub-muted px-4 text-center">
          Select a port and click Open to preview.
        </div>
      )}
      {url && (
        <button
          onClick={() => setRefreshKey((value) => value + 1)}
          className="border-t border-hub py-1 text-[11px] text-hub-tertiary hover:bg-hub-hover"
        >
          Reload preview
        </button>
      )}
      <ScreenshotComparisonCard before={beforeShot} after={afterShot} />
    </div>
  );
}
