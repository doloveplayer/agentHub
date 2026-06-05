import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const PARTICLE_COUNT = 80;
const CONNECT_DIST = 140;
const PARTICLE_COLOR = 'rgba(13, 148, 136, 0.35)';
const LINE_COLOR_BASE = 'rgba(13, 148, 136,';

export function LoginCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let animId = 0;
    let mouseX = -1000;
    let mouseY = -1000;

    const particles: Particle[] = [];

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = width;
      canvas!.height = height;
    }

    function initParticles() {
      particles.length = 0;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          r: Math.random() * 1.5 + 0.5,
        });
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Move
        p.x += p.vx;
        p.y += p.vy;

        // Wrap around
        if (p.x < -20) p.x = width + 20;
        if (p.x > width + 20) p.x = -20;
        if (p.y < -20) p.y = height + 20;
        if (p.y > height + 20) p.y = -20;

        // Mouse attraction (gentle)
        const dxM = mouseX - p.x;
        const dyM = mouseY - p.y;
        const distM = Math.sqrt(dxM * dxM + dyM * dyM);
        if (distM < 200 && distM > 0) {
          p.vx += (dxM / distM) * 0.02;
          p.vy += (dyM / distM) * 0.02;
          // Dampen
          p.vx *= 0.99;
          p.vy *= 0.99;
        }

        // Clamp speed
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (speed > 0.8) {
          p.vx = (p.vx / speed) * 0.8;
          p.vy = (p.vy / speed) * 0.8;
        }

        // Draw particle
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fillStyle = PARTICLE_COLOR;
        ctx!.fill();

        // Connect to nearby particles
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < CONNECT_DIST) {
            const opacity = (1 - dist / CONNECT_DIST) * 0.25;
            ctx!.beginPath();
            ctx!.moveTo(p.x, p.y);
            ctx!.lineTo(q.x, q.y);
            ctx!.strokeStyle = `${LINE_COLOR_BASE} ${opacity})`;
            ctx!.lineWidth = 0.5;
            ctx!.stroke();
          }
        }
      }

      animId = requestAnimationFrame(draw);
    }

    function handleMouse(e: MouseEvent) {
      mouseX = e.clientX;
      mouseY = e.clientY;
    }

    resize();
    initParticles();
    draw();

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', handleMouse);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouse);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0"
      style={{ background: 'oklch(0.985 0.01 87)' }}
    />
  );
}
