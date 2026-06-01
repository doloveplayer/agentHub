import { useState, useEffect } from 'react';
import { Folder, File, ChevronRight, ChevronDown, RefreshCw, Download, HardDrive, Box } from 'lucide-react';
import { api } from '../lib/api';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileNode[];
  source?: 'sandbox' | 'workspace';
}

interface Props {
  sessionId: string;
  onSelectFile?: (path: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function TreeNode({ node, depth, onSelect }: { node: FileNode; depth: number; onSelect?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.type === 'directory' && (node.children?.length ?? 0) > 0;

  const isWorkspace = node.source === 'workspace';
  const folderColor = isWorkspace ? 'text-blue-400' : 'text-yellow-500';
  const textColor = isWorkspace ? 'text-blue-300' : 'text-hub-secondary';

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-0.5 hover:bg-hub-hover/50 cursor-pointer text-xs"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (node.type === 'directory') setExpanded(!expanded);
          else onSelect?.(node.path);
        }}
      >
        {node.type === 'directory' ? (
          hasChildren ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="w-3" />
        ) : (
          <span className="w-3" />
        )}
        {node.type === 'directory' ? (
          <Folder size={12} className={`${folderColor} shrink-0`} />
        ) : (
          <File size={12} className={`${textColor} shrink-0 opacity-60`} />
        )}
        <span className={`truncate ${textColor}`}>{node.name}</span>
        {node.size !== undefined && (
          <span className="text-hub-muted ml-auto shrink-0">{formatSize(node.size)}</span>
        )}
      </div>
      {expanded && hasChildren && node.children!.map((child, i) => (
        <TreeNode key={child.path || i} node={child} depth={depth + 1} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function FileTree({ sessionId, onSelectFile }: Props) {
  const [sandboxTree, setSandboxTree] = useState<FileNode[]>([]);
  const [workspaceTree, setWorkspaceTree] = useState<FileNode[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const fetchTree = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getWorkspaceTree(sessionId).catch(() => null);
      setSandboxTree(data?.tree ?? []);
      setWorkspaceTree(data?.workspaceTree ?? []);
      setWorkspaceDir(data?.workspaceDir ?? null);
    } catch {
      setError('Failed to load file tree');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionId) fetchTree();
  }, [sessionId]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const token = localStorage.getItem('agenthub_token');
      const resp = await fetch(`/api/workspace/${sessionId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error('Download failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sandbox-${sessionId.slice(0, 8)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
    } finally {
      setDownloading(false);
    }
  };

  const isEmpty = sandboxTree.length === 0 && workspaceTree.length === 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-hub">
        <span className="text-xs font-medium text-hub-tertiary uppercase tracking-wide">Files</span>
        <div className="flex items-center gap-1">
          <button onClick={fetchTree} className="p-1 hover:bg-hub-hover rounded" title="Refresh">
            <RefreshCw size={12} className={loading ? 'animate-spin text-green-400' : 'text-hub-muted'} />
          </button>
          <button
            onClick={handleDownload}
            disabled={downloading || isEmpty}
            className="p-1 hover:bg-hub-hover rounded disabled:opacity-30"
            title={isEmpty ? 'No files to download' : 'Download as ZIP'}
          >
            <Download size={12} className={downloading ? 'animate-pulse text-hub-accent' : 'text-hub-muted'} />
          </button>
        </div>
      </div>

      {/* Legend */}
      {!isEmpty && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-hub bg-hub-surface/50 text-[10px] text-hub-tertiary">
          <span className="flex items-center gap-1">
            <Box size={10} className="text-yellow-500" /> Sandbox
          </span>
          {workspaceDir && (
            <span className="flex items-center gap-1">
              <HardDrive size={10} className="text-blue-400" /> Workspace
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto py-1 font-mono">
        {loading && isEmpty && (
          <div className="text-xs text-hub-muted px-3 py-2">Loading...</div>
        )}
        {error && (
          <div className="text-xs text-red-400 px-3 py-2">{error}</div>
        )}
        {!loading && isEmpty && !error && (
          <div className="text-xs text-hub-muted px-3 py-2">No files yet</div>
        )}

        {/* Sandbox section */}
        {sandboxTree.length > 0 && (
          <div>
            {sandboxTree.map((node, i) => (
              <TreeNode key={node.path || `s-${i}`} node={node} depth={0} onSelect={onSelectFile} />
            ))}
          </div>
        )}

        {/* Workspace section — with subtle separator */}
        {workspaceTree.length > 0 && (
          <div>
            {sandboxTree.length > 0 && (
              <div className="border-t border-hub-border/30 my-1 mx-2" />
            )}
            {workspaceTree.map((node, i) => (
              <TreeNode key={node.path || `w-${i}`} node={node} depth={0} onSelect={onSelectFile} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
