import { useState } from 'react';
import { FileSearch } from 'lucide-react';

export function ReviewCard({ report }: { report: any }) {
  const [states, setStates] = useState<Record<string, string>>({});
  const findings = report?.findings ?? [];
  if (findings.length === 0) return null;
  return (
    <div className="mx-4 my-3 overflow-hidden rounded-hub-lg border border-hub bg-hub-surface">
      <div className="flex items-center gap-2 border-b border-hub px-4 py-3">
        <FileSearch className="h-4 w-4 text-hub-accent" />
        <span className="text-sm font-semibold text-hub-primary">Review report</span>
      </div>
      <div className="divide-y divide-hub">
        {findings.map((finding: any) => {
          const state = states[finding.id] || finding.status || 'open';
          return (
            <div key={finding.id} className="px-4 py-3 text-xs">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('agenthub:open-diff-line', { detail: finding }))}
                className="mb-1 font-mono text-hub-link hover:underline"
              >
                {finding.file}:{finding.line}
              </button>
              <div className="text-hub-secondary">{finding.message}</div>
              <div className="mt-2 flex items-center gap-2">
                <span className="rounded bg-hub-hover px-1.5 py-0.5 text-hub-tertiary">{finding.severity}</span>
                <button onClick={() => setStates((prev) => ({ ...prev, [finding.id]: 'fixed' }))} className="rounded px-2 py-1 text-hub-success hover:bg-hub-hover">Fixed</button>
                <button onClick={() => setStates((prev) => ({ ...prev, [finding.id]: 'ignored' }))} className="rounded px-2 py-1 text-hub-tertiary hover:bg-hub-hover">Ignore</button>
                <span className="ml-auto text-hub-muted">{state}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
