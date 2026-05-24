import { useState } from 'react';
import { FileSearch } from 'lucide-react';

export function ReviewCard({ report }: { report: any }) {
  const [states, setStates] = useState<Record<string, string>>({});
  const findings = report?.findings ?? [];
  if (findings.length === 0) return null;
  return (
    <div className="mx-4 my-3 overflow-hidden rounded-lg border border-white/10 bg-slate-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <FileSearch className="h-4 w-4 text-violet-300" />
        <span className="text-sm font-semibold text-slate-100">Review report</span>
      </div>
      <div className="divide-y divide-white/10">
        {findings.map((finding: any) => {
          const state = states[finding.id] || finding.status || 'open';
          return (
            <div key={finding.id} className="px-4 py-3 text-xs">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('agenthub:open-diff-line', { detail: finding }))}
                className="mb-1 font-mono text-sky-300 hover:underline"
              >
                {finding.file}:{finding.line}
              </button>
              <div className="text-slate-300">{finding.message}</div>
              <div className="mt-2 flex items-center gap-2">
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-slate-400">{finding.severity}</span>
                <button onClick={() => setStates((prev) => ({ ...prev, [finding.id]: 'fixed' }))} className="rounded px-2 py-1 text-emerald-300 hover:bg-white/10">Fixed</button>
                <button onClick={() => setStates((prev) => ({ ...prev, [finding.id]: 'ignored' }))} className="rounded px-2 py-1 text-slate-400 hover:bg-white/10">Ignore</button>
                <span className="ml-auto text-slate-500">{state}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
