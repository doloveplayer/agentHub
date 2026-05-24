export function ScreenshotComparisonCard({ before, after }: { before?: string; after?: string }) {
  if (!before && !after) return null;
  return (
    <div className="grid gap-2 border-t border-white/10 p-2 md:grid-cols-2">
      {before && (
        <div>
          <div className="mb-1 text-[11px] text-slate-500">Before</div>
          <img src={before} alt="Before screenshot" className="max-h-52 w-full rounded border border-white/10 object-contain" />
        </div>
      )}
      {after && (
        <div>
          <div className="mb-1 text-[11px] text-slate-500">After</div>
          <img src={after} alt="After screenshot" className="max-h-52 w-full rounded border border-white/10 object-contain" />
        </div>
      )}
    </div>
  );
}
