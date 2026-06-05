import { useState, useEffect, useRef } from 'react';

export function useMousePosition() {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const rafRef = useRef<number>(0);
  const pendingRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      pendingRef.current = { x: e.clientX, y: e.clientY };
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          setPosition(pendingRef.current);
          rafRef.current = 0;
        });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return position;
}
