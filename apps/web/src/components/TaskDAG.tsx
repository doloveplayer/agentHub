import { useMemo, useState, useCallback } from 'react';
import { ReactFlow, Handle, Position, type Node, type Edge, type Connection, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { TaskState } from '../store/appStore';
import { Pencil, Trash2, ArrowRight, GripVertical } from 'lucide-react';

const STATUS_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  waiting: { bg: '#1e1e1e', border: '#3a3a3a', text: '#94a3b8' },
  queued:  { bg: '#1a2a2a', border: '#4fd1c5', text: '#99f6e4' },
  running: { bg: '#1a2a2a', border: '#4fd1c5', text: '#99f6e4' },
  done:    { bg: '#1a2e1a', border: '#38a169', text: '#86efac' },
  failed:  { bg: '#3a1e1e', border: '#e53e3e', text: '#fca5a5' },
};

function CustomTaskNode({ data }: { data: Record<string, unknown> }) {
  const t = data as unknown as TaskState;
  const style = STATUS_STYLES[t.status] || STATUS_STYLES.waiting;
  const pct = t.progress?.total
    ? Math.round((t.progress.completed / t.progress.total) * 100)
    : null;

  return (
    <div style={{
      padding: '12px 16px', borderRadius: '8px', border: `2px solid ${style.border}`,
      backgroundColor: style.bg, color: style.text, minWidth: 180, fontSize: 12,
      cursor: 'pointer', position: 'relative',
    }}>
      <Handle type="target" position={Position.Top} style={{ background: style.border, width: 10, height: 10 }} />
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{t.title}</div>
      <div style={{ fontSize: 10, opacity: 0.7 }}>{t.agentType}</div>
      {t.assignedAgentName && (
        <div style={{ fontSize: 10, color: 'var(--accent-primary)', marginTop: 2 }}>
          ↳ {t.assignedAgentName}
        </div>
      )}
      {t.status === 'running' && pct !== null && (
        <div style={{ marginTop: 6, height: 3, background: '#1e1e1e', borderRadius: 2 }}>
          <div style={{
            width: `${pct}%`, height: '100%', background: 'var(--accent-primary)',
            borderRadius: 2, transition: 'width 0.3s',
          }} />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: style.border, width: 10, height: 10 }} />
    </div>
  );
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface Props {
  tasks: TaskState[];
  onTaskClick?: (taskId: string) => void;
  /** Fired when user creates a new edge: source task → target task */
  onConnectDep?: (sourceId: string, targetId: string) => void;
  /** Fired when user wants to edit a task's description */
  onEditTask?: (taskId: string) => void;
  /** Fired when user wants to delete a task */
  onDeleteTask?: (taskId: string) => void;
}

export function TaskDAG({ tasks, onTaskClick, onConnectDep, onEditTask, onDeleteTask }: Props) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const closeMenu = useCallback(() => setContextMenu(null), []);

  const { nodes, edges } = useMemo(() => {
    const nodeMap = new Map(tasks.map(t => [t.taskId, t]));
    const inDegree = new Map<string, number>();
    const outEdges = new Map<string, string[]>();
    for (const t of tasks) {
      inDegree.set(t.taskId, t.dependsOn.length);
      for (const d of t.dependsOn) {
        const existing = outEdges.get(d) || [];
        existing.push(t.taskId);
        outEdges.set(d, existing);
      }
    }

    const layers = new Map<string, number>();
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const t of tasks) {
      if (t.dependsOn.length === 0) { layers.set(t.taskId, 0); visited.add(t.taskId); queue.push(t.taskId); }
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      const layer = layers.get(id)!;
      for (const child of (outEdges.get(id) || [])) {
        const childLayer = Math.max(layers.get(child) || 0, layer + 1);
        layers.set(child, childLayer);
        if (!visited.has(child)) { visited.add(child); queue.push(child); }
      }
    }
    for (const t of tasks) { if (!layers.has(t.taskId)) layers.set(t.taskId, 0); }

    const layerNodes = new Map<number, string[]>();
    for (const [id, layer] of layers) {
      const arr = layerNodes.get(layer) || [];
      arr.push(id);
      layerNodes.set(layer, arr);
    }

    const ns: Node[] = [];
    for (const [id, layer] of layers) {
      const yPos = layer * 120 + 20;
      const xPos = (layerNodes.get(layer) || []).indexOf(id) * 220 + 20;
      ns.push({ id, position: { x: xPos, y: yPos }, type: 'custom', data: nodeMap.get(id)! as unknown as Record<string, unknown> });
    }

    const es: Edge[] = [];
    for (const t of tasks) {
      for (const depId of t.dependsOn) {
        if (nodeMap.has(depId)) {
          es.push({
            id: `${depId}->${t.taskId}`,
            source: depId, target: t.taskId,
            style: { stroke: 'var(--border-default)', strokeWidth: 1.5 },
            animated: nodeMap.get(t.taskId)?.status === 'running',
          });
        }
      }
    }

    return { nodes: ns, edges: es };
  }, [tasks]);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target && onConnectDep) {
      onConnectDep(connection.source, connection.target);
    }
  }, [onConnectDep]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    setContextMenu({ taskId: node.id, x: event.clientX, y: event.clientY });
  }, []);

  // Close menu on click outside
  const onPaneClick = useCallback(() => closeMenu(), [closeMenu]);

  return (
    <div style={{ height: Math.max(300, tasks.length * 60 + 100) }} onClick={closeMenu}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ custom: CustomTaskNode }}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodesDraggable={true}
        nodesConnectable={true}
        elementsSelectable={true}
        onNodeClick={(_, node) => onTaskClick?.(node.id)}
        onNodeContextMenu={onNodeContextMenu}
        onConnect={onConnect}
        onPaneClick={onPaneClick}
        connectionLineStyle={{ stroke: 'var(--accent-primary)', strokeWidth: 2 }}
        defaultEdgeOptions={{ style: { stroke: 'var(--border-default)', strokeWidth: 1.5 } }}
      >
        <Background color="#ffffff08" gap={20} />
      </ReactFlow>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 100 }}
          className="bg-hub-raised border border-hub rounded-hub-lg shadow-xl py-1 min-w-[160px] text-caption"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { onEditTask?.(contextMenu.taskId); closeMenu(); }}
            className="w-full text-left px-3 py-1.5 hover:bg-hub-hover text-hub-secondary flex items-center gap-2"
          >
            <Pencil className="w-3 h-3" /> 编辑描述
          </button>
          <button
            onClick={() => { onDeleteTask?.(contextMenu.taskId); closeMenu(); }}
            className="w-full text-left px-3 py-1.5 hover:bg-hub-danger/10 text-hub-danger/80 flex items-center gap-2"
          >
            <Trash2 className="w-3 h-3" /> 删除任务
          </button>
        </div>
      )}
    </div>
  );
}
