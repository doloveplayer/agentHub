import { useState, useCallback, useMemo } from 'react';
import {
  Code, Eye, FlaskConical, Rocket, Globe, Shield,
  Trash2, ArrowRight, Save, Undo2, Download, Upload,
  type LucideIcon,
} from 'lucide-react';
import { TaskDAG } from './TaskDAG';
import type { TaskState } from '../store/appStore';

// ---- Node palette types ----

interface PaletteNode {
  type: string;
  label: string;
  icon: LucideIcon;
  color: string;
  description: string;
}

const PALETTE_NODES: PaletteNode[] = [
  { type: 'CodeAgent', label: 'Code', icon: Code, color: '#3b82f6', description: 'Write and edit code files' },
  { type: 'ReviewAgent', label: 'Review', icon: Eye, color: '#f59e0b', description: 'Review code quality' },
  { type: 'TestAgent', label: 'Test', icon: FlaskConical, color: '#10b981', description: 'Write and run tests' },
  { type: 'DeployAgent', label: 'Deploy', icon: Rocket, color: '#8b5cf6', description: 'Deploy to target platform' },
  { type: 'FrontendAgent', label: 'Frontend', icon: Globe, color: '#ec4899', description: 'Build UI components' },
  { type: 'BackendAgent', label: 'Backend', icon: Shield, color: '#14b8a6', description: 'Build API endpoints' },
  { type: 'DevOpsAgent', label: 'DevOps', icon: Upload, color: '#f97316', description: 'CI/CD and infrastructure' },
];

// ---- Edge condition types ----

type EdgeCondition = 'success' | 'failure' | 'always';

interface EdgeConditionMap {
  [edgeKey: string]: EdgeCondition;
}

function edgeKey(sourceId: string, targetId: string): string {
  return `${sourceId}->${targetId}`;
}

const CONDITION_STYLES: Record<EdgeCondition, { stroke: string; label: string }> = {
  success: { stroke: '#22c55e', label: 'success' },
  failure: { stroke: '#ef4444', label: 'failure' },
  always: { stroke: '#6b7280', label: 'always' },
};

// ---- Props ----

interface Props {
  tasks: TaskState[];
  planId?: string;
  onTasksChange?: (tasks: TaskState[]) => void;
  onSave?: (tasks: TaskState[], edgeConditions: EdgeConditionMap) => void;
  onExport?: () => void;
  onImport?: () => void;
}

// ---- Component ----

export function BlueprintEditor({ tasks, planId, onTasksChange, onSave, onExport, onImport }: Props) {
  const [edgeConditions, setEdgeConditions] = useState<EdgeConditionMap>({});
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [history, setHistory] = useState<TaskState[][]>([tasks]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const currentTasks = history[historyIndex] ?? tasks;

  // Push a new history entry
  const pushHistory = useCallback((newTasks: TaskState[]) => {
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      return [...trimmed, newTasks].slice(-50); // keep last 50 states
    });
    setHistoryIndex((prev) => prev + 1);
  }, [historyIndex]);

  // Undo
  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      setHistoryIndex((prev) => prev - 1);
      onTasksChange?.(history[historyIndex - 1]);
    }
  }, [historyIndex, history, onTasksChange]);

  // Add a new task node
  const handleAddTask = useCallback((task: {
    id: string; title: string; description: string; agentType: string;
    expectedOutput: string; priority: 'low' | 'medium' | 'high';
  }) => {
    const newTask: TaskState = {
      taskId: task.id,
      planId: planId ?? '',
      title: task.title,
      description: task.description,
      agentType: task.agentType,
      status: 'waiting',
      dependsOn: [],
      expectedOutput: task.expectedOutput,
      priority: task.priority,
    };
    const updated = [...currentTasks, newTask];
    pushHistory(updated);
    onTasksChange?.(updated);
  }, [currentTasks, planId, pushHistory, onTasksChange]);

  // Connect two nodes with a dependency edge
  const handleConnectDep = useCallback((sourceId: string, targetId: string) => {
    const key = edgeKey(sourceId, targetId);
    // Check for cycles
    const targetTask = currentTasks.find((t) => t.taskId === targetId);
    if (!targetTask) return;
    if (targetTask.dependsOn.includes(sourceId)) return; // already connected

    const updated = currentTasks.map((t) => {
      if (t.taskId === targetId) {
        return { ...t, dependsOn: [...t.dependsOn, sourceId] };
      }
      return t;
    });
    setEdgeConditions((prev) => ({
      ...prev,
      [key]: 'success' as EdgeCondition,
    }));
    pushHistory(updated);
    onTasksChange?.(updated);
  }, [currentTasks, pushHistory, onTasksChange]);

  // Edit a task node description
  const handleEditTask = useCallback((taskId: string) => {
    const task = currentTasks.find((t) => t.taskId === taskId);
    if (!task) return;
    const newDescription = window.prompt('Edit task description:', task.description ?? '');
    if (newDescription === null) return; // cancelled
    const updated = currentTasks.map((t) =>
      t.taskId === taskId ? { ...t, description: newDescription } : t
    );
    pushHistory(updated);
    onTasksChange?.(updated);
  }, [currentTasks, pushHistory, onTasksChange]);

  // Delete a task node
  const handleDeleteTask = useCallback((taskId: string) => {
    const updated = currentTasks
      .filter((t) => t.taskId !== taskId)
      .map((t) => ({
        ...t,
        dependsOn: t.dependsOn.filter((d) => d !== taskId),
      }));
    // Remove edge conditions for deleted node
    setEdgeConditions((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.startsWith(`${taskId}->`) || key.endsWith(`->${taskId}`)) {
          delete next[key];
        }
      }
      return next;
    });
    pushHistory(updated);
    onTasksChange?.(updated);
  }, [currentTasks, pushHistory, onTasksChange]);

  // Change edge condition
  const handleEdgeConditionChange = useCallback((sourceId: string, targetId: string, condition: EdgeCondition) => {
    setEdgeConditions((prev) => ({
      ...prev,
      [edgeKey(sourceId, targetId)]: condition,
    }));
    setSelectedEdge(null);
  }, []);

  // Drag from palette onto DAG area
  const handleDragStart = useCallback((e: React.DragEvent, nodeType: PaletteNode) => {
    e.dataTransfer.setData('application/blueprint-node-type', nodeType.type);
    e.dataTransfer.setData('application/blueprint-node-label', nodeType.label);
    e.dataTransfer.effectAllowed = 'copy';
  }, []);

  // Save plan
  const handleSave = useCallback(() => {
    onSave?.(currentTasks, edgeConditions);
  }, [currentTasks, edgeConditions, onSave]);

  // Build enhanced edges with condition labels for display
  const enhancedEdges = useMemo(() => {
    const result: Array<{ sourceId: string; targetId: string; condition: EdgeCondition }> = [];
    for (const task of currentTasks) {
      for (const depId of task.dependsOn) {
        const key = edgeKey(depId, task.taskId);
        const condition = edgeConditions[key] ?? 'success';
        result.push({ sourceId: depId, targetId: task.taskId, condition });
      }
    }
    return result;
  }, [currentTasks, edgeConditions]);

  return (
    <div className="flex h-full">
      {/* Node palette sidebar */}
      <div className="w-56 flex-shrink-0 border-r border-hub bg-hub-surface overflow-y-auto">
        <div className="px-3 py-3 border-b border-hub">
          <h3 className="text-sm font-semibold text-hub-primary">Node Palette</h3>
          <p className="text-[10px] text-hub-tertiary mt-0.5">
            Drag nodes onto the canvas to add
          </p>
        </div>
        <div className="p-2 space-y-1">
          {PALETTE_NODES.map((node) => (
            <div
              key={node.type}
              draggable
              onDragStart={(e) => handleDragStart(e, node)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-hub cursor-grab active:cursor-grabbing hover:bg-hub-hover transition-colors border border-transparent hover:border-hub"
              title={node.description}
            >
              <div
                className="w-7 h-7 rounded-hub flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: node.color + '20', color: node.color }}
              >
                <node.icon className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-hub-primary">{node.label}</div>
                <div className="text-[10px] text-hub-tertiary truncate">
                  {node.description}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Separator */}
        <div className="border-t border-hub mx-2 my-1" />

        {/* Edge conditions legend */}
        <div className="px-3 py-2">
          <h4 className="text-[11px] font-medium text-hub-secondary mb-1.5">
            Edge Conditions
          </h4>
          <div className="space-y-1.5">
            {Object.entries(CONDITION_STYLES).map(([key, style]) => (
              <div key={key} className="flex items-center gap-2 text-xs">
                <div
                  className="w-3 h-0.5 rounded"
                  style={{ backgroundColor: style.stroke }}
                />
                <span className="text-hub-secondary">{style.label}</span>
                <span className="text-hub-tertiary text-[10px] ml-auto">{key}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Enhanced edges list */}
        {enhancedEdges.length > 0 && (
          <div className="px-3 py-2 border-t border-hub">
            <h4 className="text-[11px] font-medium text-hub-secondary mb-1.5">
              Dependencies ({enhancedEdges.length})
            </h4>
            <div className="space-y-1">
              {enhancedEdges.map((edge) => {
                const key = edgeKey(edge.sourceId, edge.targetId);
                const style = CONDITION_STYLES[edge.condition];
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedEdge(selectedEdge === key ? null : key)}
                    className={`w-full text-left px-2 py-1 rounded text-[10px] flex items-center gap-1.5 transition-colors ${
                      selectedEdge === key
                        ? 'bg-hub-accent/10 border border-hub-accent/30'
                        : 'hover:bg-hub-hover border border-transparent'
                    }`}
                  >
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: style.stroke }}
                    />
                    <span className="text-hub-secondary font-mono truncate">
                      {edge.sourceId.slice(0, 8)}...
                    </span>
                    <ArrowRight className="w-3 h-3 text-hub-tertiary flex-shrink-0" />
                    <span className="text-hub-secondary font-mono truncate">
                      {edge.targetId.slice(0, 8)}...
                    </span>
                    {/* Condition selector popup */}
                    {selectedEdge === key && (
                      <div className="absolute mt-8 bg-hub-raised border border-hub rounded-hub-lg shadow-xl py-1 z-50">
                        {(['success', 'failure', 'always'] as EdgeCondition[]).map((cond) => (
                          <button
                            key={cond}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEdgeConditionChange(
                                edge.sourceId,
                                edge.targetId,
                                cond,
                              );
                            }}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-hub-hover flex items-center gap-2 ${
                              edge.condition === cond
                                ? 'text-hub-accent'
                                : 'text-hub-secondary'
                            }`}
                          >
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{
                                backgroundColor: CONDITION_STYLES[cond].stroke,
                              }}
                            />
                            {cond}
                            {edge.condition === cond && (
                              <span className="ml-auto text-hub-accent">&#10003;</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Main editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-hub bg-hub-surface">
          <span className="text-sm font-medium text-hub-primary">
            Blueprint Editor
          </span>
          {planId && (
            <span className="text-[10px] text-hub-tertiary font-mono bg-hub-raised px-2 py-0.5 rounded">
              {planId}
            </span>
          )}
          <div className="flex-1" />
          <span className="text-[10px] text-hub-tertiary">
            {currentTasks.length} node{currentTasks.length !== 1 ? 's' : ''}
            {' '}&middot;{' '}
            {enhancedEdges.length} edge{enhancedEdges.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={handleUndo}
            disabled={historyIndex === 0}
            className="p-1.5 rounded-hub text-hub-tertiary hover:text-hub-secondary hover:bg-hub-hover disabled:opacity-30 transition-colors"
            title="Undo"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          {onExport && (
            <button
              onClick={onExport}
              className="p-1.5 rounded-hub text-hub-tertiary hover:text-hub-accent hover:bg-hub-accent/10 transition-colors"
              title="Export blueprint"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
          {onImport && (
            <button
              onClick={onImport}
              className="p-1.5 rounded-hub text-hub-tertiary hover:text-hub-accent hover:bg-hub-accent/10 transition-colors"
              title="Import blueprint"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>
          )}
          {handleSave && (
            <button
              onClick={handleSave}
              className="flex items-center gap-1 px-3 py-1 rounded-hub text-xs font-medium bg-hub-accent text-white hover:bg-hub-accent/90 transition-colors"
            >
              <Save className="w-3 h-3" />
              Save
            </button>
          )}
        </div>

        {/* DAG canvas */}
        <div className="flex-1 min-h-0">
          <TaskDAG
            tasks={currentTasks}
            onTaskClick={(taskId) => {
              const task = currentTasks.find((t) => t.taskId === taskId);
              if (task) {
                navigator.clipboard.writeText(taskId).catch(() => {});
              }
            }}
            onConnectDep={handleConnectDep}
            onEditTask={handleEditTask}
            onDeleteTask={handleDeleteTask}
            editable={true}
            onAddTask={handleAddTask}
            onSavePlan={onSave ? () => onSave(currentTasks, edgeConditions) : undefined}
          />
        </div>
      </div>
    </div>
  );
}
