import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';

interface Props {
  /** PPTX file as base64 data or URL */
  src: string;
  /** Whether src is base64-encoded data */
  isBase64?: boolean;
}

export function PptxViewer({ src, isBase64 = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<any>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load PPTX and initialize previewer
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const { init } = await import('pptx-preview');

        let buffer: ArrayBuffer;
        if (isBase64) {
          const base64 = src.includes(',') ? src.split(',')[1] : src;
          const binary = atob(base64);
          buffer = new ArrayBuffer(binary.length);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < binary.length; i++) {
            view[i] = binary.charCodeAt(i);
          }
        } else {
          const resp = await fetch(src);
          buffer = await resp.arrayBuffer();
        }

        if (cancelled || !containerRef.current) return;

        // Destroy previous previewer if any
        if (previewerRef.current) {
          previewerRef.current.destroy();
          previewerRef.current = null;
        }

        containerRef.current.innerHTML = '';

        const previewer = init(containerRef.current, {
          width: 960,
          height: 540,
          mode: 'slide',
        });

        previewerRef.current = previewer;
        await previewer.preview(buffer);

        if (!cancelled) {
          setTotalSlides(previewer.slideCount);
          setCurrentSlide(previewer.currentIndex ?? 0);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load PPTX');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (previewerRef.current) {
        previewerRef.current.destroy();
        previewerRef.current = null;
      }
    };
  }, [src, isBase64]);

  const goToSlide = useCallback((index: number) => {
    const previewer = previewerRef.current;
    if (!previewer) return;
    const clamped = Math.max(0, Math.min(totalSlides - 1, index));
    previewer.renderSingleSlide(clamped);
    setCurrentSlide(clamped);
  }, [totalSlides]);

  const prevSlide = useCallback(() => {
    goToSlide(currentSlide - 1);
  }, [currentSlide, goToSlide]);

  const nextSlide = useCallback(() => {
    goToSlide(currentSlide + 1);
  }, [currentSlide, goToSlide]);

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(2, +(s + 0.1).toFixed(1)));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(1)));
  }, []);

  return (
    <div className="rounded border border-hub bg-hub-input overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-hub bg-hub-raised">
        <div className="flex items-center gap-1">
          <button
            onClick={prevSlide}
            disabled={currentSlide === 0}
            className="p-1 rounded hover:bg-hub-hover disabled:opacity-30"
            aria-label="Previous slide"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-hub-secondary tabular-nums">
            {currentSlide + 1} / {totalSlides || '?'}
          </span>
          <button
            onClick={nextSlide}
            disabled={currentSlide >= totalSlides - 1}
            className="p-1 rounded hover:bg-hub-hover disabled:opacity-30"
            aria-label="Next slide"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            className="p-1 rounded hover:bg-hub-hover"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="text-[10px] text-hub-muted tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            className="p-1 rounded hover:bg-hub-hover"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Slide viewport */}
      <div className="relative overflow-auto" style={{ maxHeight: 500 }}>
        {loading && (
          <div className="flex items-center justify-center py-8 text-xs text-hub-muted">
            Loading slides...
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center py-8 text-xs text-hub-danger">
            {error}
          </div>
        )}
        <div
          ref={containerRef}
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    </div>
  );
}
