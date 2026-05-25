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
    <div className="mx-4 my-3 overflow-hidden rounded-hub-lg border border-hub bg-hub-surface">
      <div className="flex items-center gap-2 border-b border-hub px-4 py-3">
        <Icon className={`h-4 w-4 ${done ? 'text-hub-success' : failed ? 'text-hub-danger' : 'text-hub-accent'}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-hub-primary">{deployment.target} deploy</div>
          <div className="text-xs text-hub-tertiary">{deployment.status}</div>
        </div>
        {failed && (
          <button
            onClick={() => api.rollbackDeployment(sessionId).catch(() => {})}
            className="inline-flex h-8 w-8 items-center justify-center rounded text-hub-secondary hover:bg-hub-hover"
            title="Rollback"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="space-y-2 px-4 py-3 text-xs">
        {deployment.url && <a href={deployment.url} target="_blank" rel="noreferrer" className="text-hub-link underline">{deployment.url}</a>}
        {deployment.buildTimeMs && <div className="text-hub-tertiary">Build: {Math.round(deployment.buildTimeMs / 1000)}s</div>}
        {deployment.imageSha && <div className="truncate font-mono text-hub-tertiary">Image: {deployment.imageSha}</div>}
        {deployment.error && <div className="text-hub-danger">{deployment.error}</div>}
        {deployment.logs.length > 0 && (
          <pre className="max-h-40 overflow-auto rounded bg-hub-code p-2 font-mono text-[11px] text-hub-tertiary">
            {deployment.logs.slice(-6).join('\n\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
