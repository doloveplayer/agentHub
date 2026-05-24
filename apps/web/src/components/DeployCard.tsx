import { CheckCircle2, CircleDashed, RotateCcw, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import type { DeploymentCardState } from '../store/appStore';

interface Props {
  sessionId: string;
  deployment: DeploymentCardState;
}

export function DeployCard({ sessionId, deployment }: Props) {
  const done = deployment.status === 'success';
  const failed = deployment.status === 'failed';
  const Icon = done ? CheckCircle2 : failed ? XCircle : CircleDashed;

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-lg border border-white/10 bg-slate-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Icon className={`h-4 w-4 ${done ? 'text-emerald-300' : failed ? 'text-red-300' : 'text-sky-300'}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-100">{deployment.target} deploy</div>
          <div className="text-xs text-slate-500">{deployment.status}</div>
        </div>
        {failed && (
          <button
            onClick={() => api.rollbackDeployment(sessionId).catch(() => {})}
            className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:bg-white/10"
            title="Rollback"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="space-y-2 px-4 py-3 text-xs">
        {deployment.url && <a href={deployment.url} target="_blank" rel="noreferrer" className="text-sky-300 underline">{deployment.url}</a>}
        {deployment.buildTimeMs && <div className="text-slate-500">Build: {Math.round(deployment.buildTimeMs / 1000)}s</div>}
        {deployment.imageSha && <div className="truncate font-mono text-slate-500">Image: {deployment.imageSha}</div>}
        {deployment.error && <div className="text-red-300">{deployment.error}</div>}
        {deployment.logs.length > 0 && (
          <pre className="max-h-40 overflow-auto rounded bg-slate-950 p-2 font-mono text-[11px] text-slate-400">
            {deployment.logs.slice(-6).join('\n\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
