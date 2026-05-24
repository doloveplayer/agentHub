import { ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';

const severities = ['critical', 'high', 'moderate', 'low', 'info'];

export function SecurityCard({ sessionId, report }: { sessionId: string; report: any }) {
  return (
    <div className="mx-4 my-3 overflow-hidden rounded-lg border border-white/10 bg-slate-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <ShieldAlert className="h-4 w-4 text-amber-300" />
        <span className="text-sm font-semibold text-slate-100">Security audit</span>
        <button
          onClick={() => api.upgradeDependencies(sessionId).catch(() => {})}
          className="ml-auto rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/25"
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
              <div className="mb-1 font-semibold uppercase text-slate-400">{severity} ({items.length})</div>
              <div className="space-y-1">
                {items.map((item: any) => (
                  <div key={`${item.packageName}-${item.title}`} className="rounded bg-white/[0.03] px-2 py-1">
                    <div className="flex gap-2">
                      <span className="font-mono text-slate-300">{item.packageName}</span>
                      <span className="text-slate-500">{item.range}</span>
                      <button
                        onClick={() => api.upgradeDependencies(sessionId, item.packageName).catch(() => {})}
                        className="ml-auto rounded px-1.5 text-[11px] text-amber-200 hover:bg-white/10"
                      >
                        Upgrade
                      </button>
                    </div>
                    <div className="text-slate-400">{item.title}</div>
                    {item.cves?.length > 0 && <div className="text-sky-300">{item.cves.join(', ')}</div>}
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
