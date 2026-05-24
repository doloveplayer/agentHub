import { Bug, CheckCircle2, XCircle } from 'lucide-react';

export function TestReportCard({ report }: { report: any }) {
  const cases = report?.cases ?? [];
  return (
    <div className="mx-4 my-3 overflow-hidden rounded-lg border border-white/10 bg-slate-900">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Bug className="h-4 w-4 text-sky-300" />
        <span className="text-sm font-semibold text-slate-100">Test report</span>
        <span className="ml-auto text-xs text-slate-500">{report?.passed ?? 0}/{report?.total ?? 0}</span>
      </div>
      <div className="divide-y divide-white/10">
        {cases.map((item: any) => (
          <div key={item.name} className="px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              {item.status === 'passed' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> : <XCircle className="h-3.5 w-3.5 text-red-300" />}
              <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{item.name}</span>
            </div>
            {item.error && (
              <>
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-slate-950 p-2 text-[11px] text-red-200">{item.error}</pre>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', {
                    detail: { prompt: `请修复这个失败测试：\n\n${item.error}` },
                  }))}
                  className="mt-2 rounded bg-sky-600/20 px-2 py-1 text-sky-200 hover:bg-sky-600/30"
                >
                  Fix
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
