import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, AlertTriangle } from 'lucide-react';
import { buildQuotePrompt, type QuotePayload } from '../lib/quoteContext';

/** Catches crashes from the pptx-preview library (e.g. missing background elements) */
class PptxErrorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message || 'Unknown rendering error' };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 text-xs text-hub-muted">
          <AlertTriangle className="h-8 w-8 text-hub-warning" />
          <p className="text-hub-tertiary">Preview unavailable for this slide</p>
          <p className="text-[11px] text-hub-muted max-w-sm text-center">
            The PPTX contains unsupported elements. Try downloading and opening with PowerPoint or LibreOffice.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  /** PPTX file as base64 data or URL */
  src: string;
  /** Whether src is base64-encoded data */
  isBase64?: boolean;
}

export function PptxViewer({ src, isBase64 = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<ReturnType<typeof import('pptx-preview').init> | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragEndRef = useRef<{ x: number; y: number } | null>(null);
  const selectingRef = useRef(false);
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

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
    try {
      previewer.renderSingleSlide(clamped);
      setCurrentSlide(clamped);
    } catch (err: any) {
      console.warn('[PptxViewer] renderSingleSlide failed:', err.message);
      setError(`This slide cannot be rendered (${err.message || 'unsupported content'}). Try another slide.`);
    }
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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    selectingRef.current = true;
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!selectingRef.current) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragEndRef.current = end;
    if (dragStartRef.current) {
      setDragRect({
        x: Math.min(dragStartRef.current.x, end.x),
        y: Math.min(dragStartRef.current.y, end.y),
        w: Math.abs(end.x - dragStartRef.current.x),
        h: Math.abs(end.y - dragStartRef.current.y),
      });
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    selectingRef.current = false;
    setDragRect(null);
    const dStart = dragStartRef.current;
    const dEnd = dragEndRef.current;
    dragStartRef.current = null;
    dragEndRef.current = null;
    if (!dStart || !dEnd || !containerRef.current) return;

    const canvas = containerRef.current.querySelector('canvas');
    if (!canvas) return;

    const x = Math.min(dStart.x, dEnd.x) / scale;
    const y = Math.min(dStart.y, dEnd.y) / scale;
    const w = Math.abs(dEnd.x - dStart.x) / scale;
    const h = Math.abs(dEnd.y - dStart.y) / scale;

    if (w < 10 || h < 10) return;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = w;
    cropCanvas.height = h;
    const ctx = cropCanvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      const dataUrl = cropCanvas.toDataURL('image/png');
      const payload: QuotePayload = {
        text: `[PPT 幻灯片 ${currentSlide + 1} 截图区域]`,
        sourceType: 'ppt',
        contextMeta: { filePath: `slide-${currentSlide + 1}` },
      };
      const prompt = buildQuotePrompt(payload);
      window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', {
        detail: {
          prompt: `请分析这个PPT截图的视觉内容：\n${dataUrl.slice(0, 200)}...\n\n（完整截图数据已通过文件上传至工作区）\n\n${prompt}`,
          quoteRef: {
            selectionText: payload.text,
            sourceType: 'ppt',
            contextMeta: { filePath: `slide-${currentSlide + 1}`, scale: `${Math.round(scale * 100)}%` },
          },
        },
      }));
    }
  }, [scale, currentSlide]);

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
      <div
        className="relative overflow-auto cursor-crosshair"
        style={{ maxHeight: 500 }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
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
        <PptxErrorBoundary>
          <div
            ref={containerRef}
            style={{
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
        </PptxErrorBoundary>
        {/* Selection overlay using stable dragRect state */}
        {dragRect && (
          <div
            className="absolute border-2 border-hub-accent bg-hub-accent/10 pointer-events-none"
            style={{
              left: dragRect.x,
              top: dragRect.y,
              width: dragRect.w,
              height: dragRect.h,
            }}
          />
        )}
      </div>
    </div>
  );
}
