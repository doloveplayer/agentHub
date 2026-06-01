import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, AlertTriangle } from 'lucide-react';
import { buildQuotePrompt, type QuotePayload } from '../lib/quoteContext';
import type { PptxFallbackSlide } from '../lib/pptxFallback';

const PPTX_PREVIEW_FALLBACK_MESSAGE =
  'The PPTX was downloaded, but browser preview cannot render this file. Open it in PowerPoint or LibreOffice from the download button.';

export function normalizePptxPreviewError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || '');
  const lower = raw.toLowerCase();
  if (
    lower.includes('t is undefined') ||
    lower.includes('cannot read properties of undefined') ||
    lower.includes('undefined is not an object') ||
    lower.includes('null is not an object')
  ) {
    return PPTX_PREVIEW_FALLBACK_MESSAGE;
  }

  return raw ? `Browser preview cannot render this PPTX file: ${raw}` : PPTX_PREVIEW_FALLBACK_MESSAGE;
}

/** Catches crashes from the pptx-preview library (e.g. missing background elements) */
class PptxErrorBoundary extends Component<{ children: React.ReactNode; onError?: (message: string) => void }, { error: string | null }> {
  constructor(props: { children: React.ReactNode; onError?: (message: string) => void }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error: normalizePptxPreviewError(error) };
  }
  componentDidCatch(error: Error) {
    this.props.onError?.(normalizePptxPreviewError(error));
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 text-xs text-hub-muted">
          <AlertTriangle className="h-8 w-8 text-hub-warning" />
          <p className="text-hub-tertiary">Preview unavailable</p>
          <p className="text-[11px] text-hub-muted max-w-sm text-center">
            {this.state.error}
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
  onPreviewError?: (message: string) => void;
}

export function PptxViewer({ src, isBase64 = false, onPreviewError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewerRef = useRef<ReturnType<typeof import('pptx-preview').init> | null>(null);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [totalSlides, setTotalSlides] = useState(0);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fallbackSlides, setFallbackSlides] = useState<PptxFallbackSlide[] | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragEndRef = useRef<{ x: number; y: number } | null>(null);
  const selectingRef = useRef(false);
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Load PPTX and initialize previewer
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      let buffer: ArrayBuffer | null = null;
      try {
        setLoading(true);
        setError(null);
        setFallbackSlides(null);

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
          if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
          buffer = await resp.arrayBuffer();
        }

        if (cancelled || !containerRef.current) return;

        const { init } = await import('pptx-preview');

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
          setFallbackSlides(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          const message = normalizePptxPreviewError(err);
          if (buffer) {
            try {
              const { parsePptxFallbackSlides } = await import('../lib/pptxFallback');
              const fallback = await parsePptxFallbackSlides(buffer);
              if (!cancelled && fallback.length > 0) {
                if (previewerRef.current) {
                  previewerRef.current.destroy();
                  previewerRef.current = null;
                }
                if (containerRef.current) containerRef.current.innerHTML = '';
                setFallbackSlides(fallback);
                setTotalSlides(fallback.length);
                setCurrentSlide(0);
                setError(null);
                return;
              }
            } catch (fallbackErr) {
              console.warn('[PptxViewer] fallback parser failed:', fallbackErr);
            }
          }
          setFallbackSlides(null);
          setError(message);
          onPreviewError?.(message);
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
  }, [src, isBase64, onPreviewError]);

  const goToSlide = useCallback((index: number) => {
    if (fallbackSlides?.length) {
      setCurrentSlide(Math.max(0, Math.min(fallbackSlides.length - 1, index)));
      return;
    }

    const previewer = previewerRef.current;
    if (!previewer) return;
    const clamped = Math.max(0, Math.min(totalSlides - 1, index));
    try {
      previewer.renderSingleSlide(clamped);
      setCurrentSlide(clamped);
    } catch (err: any) {
      const message = normalizePptxPreviewError(err);
      console.warn('[PptxViewer] renderSingleSlide failed:', err.message);
      setError(message);
      onPreviewError?.(message);
    }
  }, [fallbackSlides, totalSlides, onPreviewError]);

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
        {fallbackSlides?.length ? (
          <FallbackSlideRenderer slide={fallbackSlides[currentSlide]} scale={scale} />
        ) : (
          <PptxErrorBoundary onError={onPreviewError}>
            <div
              ref={containerRef}
              style={{
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
              }}
            />
          </PptxErrorBoundary>
        )}
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

function FallbackSlideRenderer({ slide, scale }: { slide: PptxFallbackSlide; scale: number }) {
  const width = 960;
  const height = Math.round(width * (slide.height / slide.width));

  return (
    <div className="p-3">
      <div
        className="relative overflow-hidden bg-white shadow"
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {slide.elements.map((element) => {
          const hasText = element.text.trim().length > 0;
          return (
            <div
              key={element.id}
              className="absolute overflow-hidden"
              style={{
                left: `${element.x * 100}%`,
                top: `${element.y * 100}%`,
                width: `${element.w * 100}%`,
                height: `${element.h * 100}%`,
                backgroundColor: element.fill,
                color: textColorForFill(element.fill),
                fontSize: element.fontSize ? `${Math.max(8, element.fontSize)}px` : '14px',
                fontWeight: element.bold ? 700 : 400,
                lineHeight: 1.28,
                padding: hasText ? '8px' : undefined,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {hasText ? element.text : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function textColorForFill(fill?: string): string {
  if (!fill) return '#111827';
  const match = fill.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!match) return '#111827';
  const value = match[1];
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.45 ? '#ffffff' : '#111827';
}
