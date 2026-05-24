import { useState } from 'react';
import JSZip from 'jszip';
import { ChevronLeft, ChevronRight, FileDown, Upload } from 'lucide-react';

interface Slide {
  index: number;
  title: string;
  lines: string[];
}

export function PPTViewer() {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [active, setActive] = useState(0);
  const [fileName, setFileName] = useState('');

  const onFile = async (file: File) => {
    setFileName(file.name);
    if (!file.name.toLowerCase().endsWith('.pptx')) {
      setSlides([{ index: 1, title: file.name, lines: ['Legacy .ppt files require conversion to .pptx before inline parsing.'] }]);
      setActive(0);
      return;
    }
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b));
    const parsed: Slide[] = [];
    for (const name of slideFiles) {
      const xml = await zip.file(name)!.async('text');
      const lines = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)]
        .map((match) => decodeXml(match[1]))
        .filter(Boolean);
      parsed.push({
        index: parsed.length + 1,
        title: lines[0] || `Slide ${parsed.length + 1}`,
        lines: lines.length ? lines : ['(empty slide)'],
      });
    }
    setSlides(parsed);
    setActive(0);
  };

  if (slides.length === 0) {
    return (
      <label className="flex cursor-pointer items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-400 hover:bg-white/[0.06]">
        <Upload className="h-4 w-4" />
        PPT/PPTX
        <input
          type="file"
          accept=".ppt,.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFile(file).catch(() => {});
          }}
        />
      </label>
    );
  }

  const slide = slides[active];

  return (
    <div className="overflow-hidden rounded-md border border-white/10 bg-slate-950/80">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{fileName}</span>
        <button
          onClick={() => window.print()}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-white/10"
          title="Export PDF"
        >
          <FileDown className="h-4 w-4" />
        </button>
      </div>
      <div className="flex">
        <div className="w-24 shrink-0 space-y-1 border-r border-white/10 p-2">
          {slides.map((item, index) => (
            <button
              key={item.index}
              onClick={() => setActive(index)}
              className={`block aspect-video w-full rounded border px-1 text-[10px] ${
                active === index ? 'border-sky-400 bg-sky-500/15 text-sky-100' : 'border-white/10 bg-white/[0.03] text-slate-500'
              }`}
              title={item.title}
            >
              {item.index}
            </button>
          ))}
        </div>
        <div className="min-h-56 flex-1 p-5">
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={() => setActive((value) => Math.max(0, value - 1))}
              className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:bg-white/10"
              title="Previous slide"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-slate-500">{slide.index} / {slides.length}</span>
            <button
              onClick={() => setActive((value) => Math.min(slides.length - 1, value + 1))}
              className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:bg-white/10"
              title="Next slide"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="aspect-video rounded bg-white p-6 text-slate-950 shadow">
            <h3 className="mb-4 text-xl font-semibold">{slide.title}</h3>
            <ul className="space-y-2 text-sm">
              {slide.lines.slice(1).map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}
