import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hook for making a panel resizable via a draggable handle.
 * Returns [width, resizeHandleProps, panelRef].
 * The width is clamped between minWidth and maxWidth.
 */
export function useResizablePanel(options: {
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  side: 'left' | 'right';
}) {
  const { defaultWidth, minWidth = 180, maxWidth = 480, side } = options;
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startWidth = width;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = side === 'right' ? -(ev.clientX - startX) : ev.clientX - startX;
        const next = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
        setWidth(next);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = side === 'right' ? 'col-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width, minWidth, maxWidth, side],
  );

  useEffect(() => {
    return () => {
      // Cleanup on unmount
    };
  }, []);

  return { width, onMouseDown, panelRef };
}
