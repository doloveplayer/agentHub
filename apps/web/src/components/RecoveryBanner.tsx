import React from 'react';
import { AlertTriangle, Play, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { socketPool } from '../hooks/useChat';

interface Props {
  sessionId: string;
}

export function RecoveryBanner({ sessionId }: Props) {
  const recoveries = useAppStore((s) => s.planRecoveries[sessionId]) ?? [];
  const removeRecoveryPlan = useAppStore((s) => s.removeRecoveryPlan);

  if (recoveries.length === 0) return null;

  const sendWs = (data: object) => {
    const ws = socketPool.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      console.warn('[RecoveryBanner] WebSocket not connected');
    }
  };

  const handleContinue = (planId: string) => {
    sendWs({ type: 'recover_plan', planId });
  };

  const handleDiscard = (planId: string) => {
    sendWs({ type: 'discard_plan', planId });
    // Also discard locally
    removeRecoveryPlan(sessionId, planId);
  };

  return (
    <div className="space-y-2 px-3 py-2">
      {recoveries.map((r) => (
        <div key={r.planId} className="flex items-start gap-3 bg-hub-warning/10 border border-hub-warning/30 rounded-lg px-4 py-3">
          <AlertTriangle className="w-5 h-5 text-hub-warning mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-hub-primary">
              Incomplete plan detected: <span className="text-hub-warning">{r.planTitle}</span>
            </p>
            <p className="text-xs text-hub-tertiary mt-0.5">
              {r.pendingCount} pending task{r.pendingCount !== 1 ? 's' : ''}: {r.pendingTasks.map(t => t.title).join(', ')}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => handleContinue(r.planId)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-hub-accent text-white rounded-md hover:bg-hub-accent/80 transition"
            >
              <Play className="w-3 h-3" /> Continue
            </button>
            <button
              onClick={() => handleDiscard(r.planId)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-hub-tertiary hover:text-hub-danger hover:bg-hub-hover rounded-md transition"
            >
              <Trash2 className="w-3 h-3" /> Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
