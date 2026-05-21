import { useMemo } from 'react';
import { ReactFlow, Handle, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { TaskState } from '../store/appStore';

const STATUS_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  waiting: { bg: '#1e293b', border: '#475569', text: '#94a3b8' },
  running: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
  done:    { bg: '#1e3a3a', border: '#22c55e', text: '#86efac' },
  failed:  { bg: '#3a1e1e', border: '#ef4444', text: '#fca5a5' },
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
      <Handle type="target" position={Position.Top} style={{ background: style.border }} />
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{t.title}</div>
      <div style={{ fontSize: 10, opacity: 0.7 }}>{t.agentType}</div>
      {t.status === 'running' && pct !== null && (
        <div style={{ marginTop: 6, height: 3, background: '#1e293b', borderRadius: 2 }}>
          <div style={{
            width: `${pct}%`, height: '100%', background: '#3b82f6',
            borderRadius: 2, transition: 'width 0.3s',
          }} />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ background: style.border }} />
    </div>
  );
}

interface Props {
  tasks: TaskState[];
  onTaskClick?: (taskId: string) => void;
}

export function TaskDAG({ tasks, onTaskClick }: Props) {
  const { nodes, edges } = useMemo(() => {
    const nodeMap = new Map(tasks.map(t => [t.taskId, t]));

    // Simple layered layout: count incoming edges per node → layer index
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

    // Assign layers via BFS from roots, with visited guard to prevent cycles
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

    // Group nodes by layer
    const layerNodes = new Map<number, string[]>();
    for (const [id, layer] of layers) {
      const arr = layerNodes.get(layer) || [];
      arr.push(id);
      layerNodes.set(layer, arr);
    }

    const ns: Node[] = [];
    const layerCounts = new Map<number, number>();
    for (const [layer, ids] of layerNodes) layerCounts.set(layer, ids.length);

    for (const [id, layer] of layers) {
      const idx = layerCounts.get(layer)! > 0 ? (layerCounts.get(layer)! - 1) : 0;
      layerCounts.set(layer, idx - 1);
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
            style: { stroke: '#475569', strokeWidth: 1.5 },
          });
        }
      }
    }

    return { nodes: ns, edges: es };
  }, [tasks]);

  return (
    <div style={{ height: Math.max(300, tasks.length * 60 + 100) }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ custom: CustomTaskNode }}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        onNodeClick={(_, node) => onTaskClick?.(node.id)}
      />
    </div>
  );
}
