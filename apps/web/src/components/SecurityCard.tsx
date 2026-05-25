import { ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';

const severities = ['critical', 'high', 'moderate', 'low', 'info'];

export function SecurityCard({ sessionId, report }: { sessionId: string; report: any }) {
  return (
    <div className="mx-4 my-3 overflow-hidden rounded-hub-lg border border-hub bg-hub-surface">
      <div className="flex items-center gap-2 border-b border-hub px-4 py-3">
        <ShieldAlert className="h-4 w-4 text-hub-warning" />
        <span className="text-sm font-semibold text-hub-primary">Security audit</span>
        <button
          onClick={() => api.upgradeDependencies(sessionId).catch(() => {})}
          className="ml-auto rounded bg-hub-warning/15 px-2 py-1 text-xs text-hub-warning hover:bg-hub-warning/25"
        >
          Upgrade
        </button>
      </div>
      <div className="space-y-3 p-4 text-xs">
        {severities.map((severity) => {
          const items = report?.bySeverity?.[severity] ?? [];
          if (items.length === 0) return null;
          return (
            <div key={severity}>
              <div className="mb-1 font-semibold uppercase text-hub-tertiary">{severity} ({items.length})</div>
              <div className="space-y-1">
                {items.map((item: any) => (
                  <div key={`${item.packageName}-${item.title}`} className="rounded bg-hub-hover px-2 py-1">
                    <div className="flex gap-2">
                      <span className="font-mono text-hub-secondary">{item.packageName}</span>
                      <span className="text-hub-tertiary">{item.range}</span>
                      <button
                        onClick={() => api.upgradeDependencies(sessionId, item.packageName).catch(() => {})}
                        className="ml-auto rounded px-1.5 text-[11px] text-hub-warning hover:bg-hub-hover"
                      >
                        Upgrade
                      </button>
                    </div>
                    <div className="text-hub-tertiary">{item.title}</div>
                    {item.cves?.length > 0 && <div className="text-hub-link">{item.cves.join(', ')}</div>}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
