import { Bug, CheckCircle2, XCircle } from 'lucide-react';

export function TestReportCard({ report }: { report: any }) {
  const cases = report?.cases ?? [];
  return (
    <div className="mx-4 my-3 overflow-hidden rounded-hub-lg border border-hub bg-hub-surface">
      <div className="flex items-center gap-2 border-b border-hub px-4 py-3">
        <Bug className="h-4 w-4 text-hub-accent" />
        <span className="text-sm font-semibold text-hub-primary">Test report</span>
        <span className="ml-auto text-xs text-hub-tertiary">{report?.passed ?? 0}/{report?.total ?? 0}</span>
      </div>
      <div className="divide-y divide-hub">
        {cases.map((item: any) => (
          <div key={item.name} className="px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              {item.status === 'passed' ? <CheckCircle2 className="h-3.5 w-3.5 text-hub-success" /> : <XCircle className="h-3.5 w-3.5 text-hub-danger" />}
              <span className="min-w-0 flex-1 truncate font-mono text-hub-secondary">{item.name}</span>
            </div>
            {item.error && (
              <>
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-hub-code p-2 text-[11px] text-hub-danger">{item.error}</pre>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', {
                    detail: { prompt: `请修复这个失败测试：\n\n${item.error}` },
                  }))}
                  className="mt-2 rounded bg-hub-accent/20 px-2 py-1 text-hub-accent hover:bg-hub-accent/30"
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
