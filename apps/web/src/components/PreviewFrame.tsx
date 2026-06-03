import { useEffect, useState } from 'react';
import { ChevronDown, ExternalLink, FolderOpen, Globe, RefreshCcw } from 'lucide-react';
import { api } from '../lib/api';
import { ScreenshotComparisonCard } from './ScreenshotComparisonCard';

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
}

function collectDirs(nodes: TreeNode[]): string[] {
  const dirs: string[] = [];
  for (const n of nodes) {
    if (n.type === 'directory') {
      dirs.push(n.path);
      if (n.children?.length) dirs.push(...collectDirs(n.children));
    }
  }
  return dirs;
}

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
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

  const fetchDirs = async () => {
    try {
      const { tree, workspaceTree, sandboxDir } = await api.getWorkspaceTree(sessionId);
      const allDirs = [...collectDirs(tree || []), ...collectDirs(workspaceTree || [])];
      const unique = [...new Set(allDirs)].sort();
      // Prepend sandbox/workspace roots
      const roots = [sandboxDir || '/workspace'];
      return { dirs: [...roots, ...unique.filter(d => !roots.includes(d))], sandboxDir: sandboxDir || '/workspace' };
    } catch {
      return { dirs: ['/workspace'], sandboxDir: '/workspace' };
    }
  };

  const [dirs, setDirs] = useState<string[]>(['/workspace']);

  useEffect(() => {
    let cancelled = false;
    fetchDirs().then(({ dirs, sandboxDir }) => {
      if (cancelled) return;
      setDirs(dirs);
      setStaticDir(prev => (prev === '/workspace' && sandboxDir !== '/workspace') ? sandboxDir : prev);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  const withToken = (proxyUrl: string) => {
    const token = localStorage.getItem('agenthub_token');
    if (!token) return proxyUrl;
    const sep = proxyUrl.includes('?') ? '&' : '?';
    return `${proxyUrl}${sep}token=${encodeURIComponent(token)}`;
  };

  const serveStatic = async () => {
    setServing(true);
    setServeError(null);
    try {
      const result = await api.serveStaticDir(sessionId, staticDir);
      setUrl(withToken(result.proxyUrl));
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
      setUrl(withToken(result.proxyUrl) || result.url);
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
        <div className="relative flex-1 min-w-0">
          <button
            onClick={() => setDirPickerOpen(v => !v)}
            className="flex h-8 w-full items-center gap-1.5 rounded border border-hub bg-hub-input px-2 text-xs text-hub-primary font-mono hover:bg-hub-hover"
          >
            <span className="flex-1 truncate text-left">{staticDir}</span>
            <ChevronDown className="h-3.5 w-3.5 text-hub-tertiary shrink-0" />
          </button>
          {dirPickerOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setDirPickerOpen(false)} />
              <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-48 overflow-auto rounded border border-hub bg-hub-surface shadow-lg">
              {dirs.map(d => (
                <button
                  key={d}
                  onClick={() => { setStaticDir(d); setDirPickerOpen(false); }}
                  className={`w-full px-2 py-1.5 text-left text-xs font-mono hover:bg-hub-accent/20 ${
                    d === staticDir ? 'text-hub-accent bg-hub-accent/10' : 'text-hub-secondary'
                  }`}
                >
                  {d}
                </button>
              ))}
              <div className="border-t border-hub px-2 py-1.5">
                <input
                  value={staticDir}
                  onChange={e => setStaticDir(e.target.value)}
                  placeholder="Or type custom path..."
                  className="w-full rounded border border-hub bg-hub-input px-2 py-1 text-xs text-hub-primary font-mono outline-none focus:border-hub-accent"
                />
              </div>
              </div>
            </>
          )}
        </div>
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
