import { useState, useEffect } from 'react';
import { Folder, File, ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileNode[];
}

interface Props {
  sessionId: string;
  onSelectFile?: (path: string) => void;
}

function TreeNode({ node, depth, onSelect }: { node: FileNode; depth: number; onSelect?: (path: string) => void }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.type === 'directory' && (node.children?.length ?? 0) > 0;

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
          <Folder size={12} className="text-yellow-500 shrink-0" />
        ) : (
          <File size={12} className="text-hub-tertiary shrink-0" />
        )}
        <span className="truncate text-hub-secondary">{node.name}</span>
        {node.size !== undefined && (
          <span className="text-hub-muted ml-auto shrink-0">
            {node.size < 1024 ? `${node.size}B` : node.size < 1048576 ? `${(node.size / 1024).toFixed(1)}KB` : `${(node.size / 1048576).toFixed(1)}MB`}
          </span>
        )}
      </div>
      {expanded && hasChildren && node.children!.map((child, i) => (
        <TreeNode key={child.path || i} node={child} depth={depth + 1} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function FileTree({ sessionId, onSelectFile }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTree = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getWorkspaceTree(sessionId).catch(() => null);
      setTree(data?.tree ?? []);
    } catch {
      setError('Failed to load file tree');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionId) fetchTree();
  }, [sessionId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-hub">
        <span className="text-xs font-medium text-hub-tertiary uppercase tracking-wide">Files</span>
        <button onClick={fetchTree} className="p-1 hover:bg-hub-hover rounded" title="Refresh">
          <RefreshCw size={12} className={loading ? 'animate-spin text-green-400' : 'text-hub-muted'} />
        </button>
      </div>
      <div className="flex-1 overflow-auto py-1 font-mono">
        {loading && tree.length === 0 && (
          <div className="text-xs text-hub-muted px-3 py-2">Loading...</div>
        )}
        {error && (
          <div className="text-xs text-red-400 px-3 py-2">{error}</div>
        )}
        {!loading && tree.length === 0 && !error && (
          <div className="text-xs text-hub-muted px-3 py-2">No files yet</div>
        )}
        {tree.map((node, i) => (
          <TreeNode key={node.path || i} node={node} depth={0} onSelect={onSelectFile} />
        ))}
      </div>
    </div>
  );
}
