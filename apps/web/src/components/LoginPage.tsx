import { useState, useRef, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useMousePosition } from '../hooks/useMousePosition';
import { ChatPage } from '../pages/ChatPage';

const CX = 44, CY = 50;
const BTN_CX = 50, BTN_CY = 53;

const SLOGANS = [
  { text: '一句话，一个团队',      x: `${CX - 32}%`, y: `${CY - 2}%`,  size: 'text-7xl' },
  { text: '所想即所得',            x: `${CX + 22}%`, y: `${CY + 1}%`,  size: 'text-7xl' },
  { text: 'AI 队友，随叫随到',     x: `${CX - 36}%`, y: `${CY + 8}%`,  size: 'text-6xl' },
  { text: '产物预览与编辑',        x: `${CX + 26}%`, y: `${CY + 10}%`, size: 'text-6xl' },
  { text: '多智能体协同作战',      x: `${CX - 30}%`, y: `${CY - 10}%`, size: 'text-6xl' },
  { text: 'WebSocket 实时流',      x: `${CX + 20}%`, y: `${CY - 8}%`,  size: 'text-5xl' },
  { text: '聊天式智能办公',        x: `${CX - 26}%`, y: `${CY - 20}%`, size: 'text-5xl' },
  { text: 'DAG 任务编排',          x: `${CX + 18}%`, y: `${CY - 18}%`, size: 'text-5xl' },
  { text: '沙箱安全隔离',          x: `${CX - 28}%`, y: `${CY + 20}%`, size: 'text-5xl' },
  { text: '版本追踪与回溯',        x: `${CX + 24}%`, y: `${CY + 22}%`, size: 'text-5xl' },
  { text: '容器级工作空间',        x: `${CX - 16}%`, y: `${CY - 30}%`, size: 'text-5xl' },
  { text: '智能上下文管理',        x: `${CX + 12}%`, y: `${CY - 28}%`, size: 'text-5xl' },
  { text: '生产力十倍提升',        x: `${CX - 18}%`, y: `${CY + 30}%`, size: 'text-5xl' },
  { text: '告别重复劳动',          x: `${CX + 14}%`, y: `${CY + 32}%`, size: 'text-5xl' },
  { text: '下一代工作方式',        x: `${CX - 6}%`,  y: `${CY - 38}%`, size: 'text-4xl' },
  { text: '多平台 Agent 接入',     x: `${CX + 4}%`,  y: `${CY - 36}%`, size: 'text-4xl' },
  { text: '跨会话记忆共享',        x: `${CX - 8}%`,  y: `${CY + 38}%`, size: 'text-4xl' },
  { text: '权限代理与审计',        x: `${CX + 6}%`,  y: `${CY + 40}%`, size: 'text-4xl' },
];

function PhilosophyText() {
  return (
    <>
      {SLOGANS.map((s) => {
        const px = parseFloat(s.x), py = parseFloat(s.y);
        const dist = Math.sqrt((px - CX) ** 2 + (py - CY) ** 2);
        return (
          <span key={s.text}
            className={`absolute ${s.size} font-extrabold tracking-wider whitespace-nowrap`}
            style={{ left: s.x, top: s.y, color: '#4fd1c5', opacity: 1 - (dist / 42) * 0.6 }}>
            {s.text}
          </span>
        );
      })}
    </>
  );
}

type Phase = 'converge' | 'liquid' | 'expand' | 'reveal';

function ConvergeAnimationLayer({
  glowRef, workspaceRef, overlayRef,
}: {
  glowRef: React.RefObject<HTMLDivElement | null>;
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  overlayRef: React.RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const btnX = (BTN_CX / 100) * window.innerWidth;
    const btnY = (BTN_CY / 100) * window.innerHeight;

    const items = Array.from(container.querySelectorAll('.char-item')) as HTMLElement[];
    const chars = items.map((el) => {
      const sx = parseFloat(el.dataset.sx!);
      const sy = parseFloat(el.dataset.sy!);
      const dist = Math.sqrt((sx - btnX) ** 2 + (sy - btnY) ** 2);
      return {
        el, sx, sy, dist,
        // 轻微弧线偏移，让路径不完全直线
        curve: (Math.random() - 0.5) * 60,
      };
    });

    const PHASE1 = 1100; // 收拢
    const PHASE2 = 500;  // 液体融合
    const PHASE3 = 400;  // 扩展反转
    const PHASE4 = 300;  // 暗中显现
    const TOTAL = PHASE1 + PHASE2 + PHASE3 + PHASE4;
    const startTime = performance.now();
    let currentPhase: Phase = 'converge';

    function easeOutQuart(t: number) {
      return 1 - Math.pow(1 - t, 4);
    }
    function easeInOutCubic(t: number) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function animate(now: number) {
      const elapsed = now - startTime;

      // ── Phase 1: 各字从初始位置沿弧线收拢至中心 ──
      if (elapsed < PHASE1) {
        const t = elapsed / PHASE1;
        const eased = easeOutQuart(t);

        for (const ch of chars) {
          // 按距离远近延迟启动，远处先动
          const delay = (1 - ch.dist / 500) * 0.3;
          const localT = Math.max(0, Math.min(1, (t - delay) / (1 - delay)));
          const lt = easeOutQuart(localT);

          // 弧线插值：直线 + 垂直方向的弧度偏移
          const dx = btnX - ch.sx;
          const dy = btnY - ch.sy;
          const perpX = -dy / ch.dist;
          const perpY = dx / ch.dist;
          const curveFactor = Math.sin(lt * Math.PI) * ch.curve * (1 - lt);

          const x = ch.sx + dx * lt + perpX * curveFactor;
          const y = ch.sy + dy * lt + perpY * curveFactor;

          ch.el.style.transform = `translate(${x - ch.sx}px, ${y - ch.sy}px)`;
          ch.el.style.opacity = String(localT > 0 ? 1 : 0);
          // 接近中心时逐渐模糊 → 液体感
          ch.el.style.filter = lt > 0.6 ? `blur(${(lt - 0.6) * 8}px)` : 'none';
        }

        // 中心光点随收拢进度增长
        if (glowRef.current) {
          const size = 2 + eased * 10;
          glowRef.current.style.cssText =
            `position:fixed; left:50%; top:53%; transform:translate(-50%,-50%); ` +
            `border-radius:50%; z-index:25; pointer-events:none; ` +
            `width:${size}vw; height:${size}vw; opacity:${eased * 0.8}; ` +
            `background:radial-gradient(circle, rgba(56,189,248,0.9) 0%, rgba(56,189,248,0.3) 50%, rgba(56,189,248,0) 70%); ` +
            `filter:blur(${30 - eased * 20}px);`;
        }
      }

      // ── Phase 2: 液体融合 — 文字消失，光点脉动膨胀 ──
      else if (elapsed < PHASE1 + PHASE2) {
        if (currentPhase === 'converge') {
          currentPhase = 'liquid';
          for (const ch of chars) ch.el.style.opacity = '0';
        }
        const t = (elapsed - PHASE1) / PHASE2;
        const eased = easeInOutCubic(t);
        // 脉动：先扩大后微缩再扩大
        const pulse = 1 + 0.15 * Math.sin(t * Math.PI * 3) * (1 - t);
        const size = 12 + eased * 18 * pulse;

        if (glowRef.current) {
          glowRef.current.style.cssText =
            `position:fixed; left:50%; top:53%; transform:translate(-50%,-50%) scale(${pulse}); ` +
            `border-radius:50%; z-index:25; pointer-events:none; ` +
            `width:${size}vw; height:${size * 0.9}vw; opacity:1; ` +
            `background:radial-gradient(ellipse, rgba(56,189,248,1) 0%, rgba(56,189,248,0.8) 30%, ` +
            `rgba(99,179,237,0.5) 50%, rgba(56,189,248,0) 70%); ` +
            `filter:blur(${20 - eased * 10}px);`;
        }
      }

      // ── Phase 3: 扩展 + 渐变反转 ──
      else if (elapsed < PHASE1 + PHASE2 + PHASE3) {
        if (currentPhase === 'liquid') {
          currentPhase = 'expand';
        }
        const t = (elapsed - PHASE1 - PHASE2) / PHASE3;
        const eased = easeInOutCubic(t);
        const inner = 100 - eased * 100;
        const outer = 100 - inner;
        if (glowRef.current) {
          glowRef.current.style.cssText =
            `position:fixed; inset:0; z-index:25; pointer-events:none; ` +
            `background:radial-gradient(circle at 50% 53%, ` +
            `rgba(56,189,248,${0.8 * (1 - eased)}) ${inner}%, ` +
            `rgba(15,23,42,${0.6 + eased * 0.4}) ${outer}%);`;
        }
      }

      // ── Phase 4: 暗中显现 ──
      else {
        if (currentPhase === 'expand') {
          currentPhase = 'reveal';
          if (workspaceRef.current) workspaceRef.current.style.display = 'block';
        }
        const t = Math.min((elapsed - PHASE1 - PHASE2 - PHASE3) / PHASE4, 1);
        const eased = easeInOutCubic(t);
        if (glowRef.current) glowRef.current.style.opacity = String(1 - eased);
        if (workspaceRef.current) workspaceRef.current.style.opacity = String(eased);
        if (overlayRef.current) overlayRef.current.style.opacity = String(1 - eased);
      }

      if (elapsed < TOTAL) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  }, [glowRef, workspaceRef, overlayRef]);

  // 渲染：每句话的字紧凑排列，但每个字独立运动
  const charElements: JSX.Element[] = [];
  SLOGANS.forEach((s, si) => {
    const chars = s.text.split('');
    chars.forEach((ch, ci) => {
      // 字间距紧密：字宽 * 0.6（不拉开）
      const offsetX = ci * (parseInt(s.size.replace('text-', '')) * 3.5 * 0.6);
      const baseX = parseFloat(s.x) * window.innerWidth / 100;
      const baseY = parseFloat(s.y) * window.innerHeight / 100;

      charElements.push(
        <div key={`${si}-${ci}`}
          className="char-item absolute"
          data-sx={baseX + offsetX}
          data-sy={baseY}
          style={{
            left: '0', top: '0',
            willChange: 'transform, opacity, filter',
          }}>
          <span className={`${s.size} font-extrabold`}
            style={{
              color: '#4fd1c5',
              position: 'fixed',
              left: `${baseX + offsetX}px`,
              top: `${baseY}px`,
            }}>
            {ch}
          </span>
        </div>
      );
    });
  });

  return (
    <div ref={containerRef} className="pointer-events-none fixed inset-0 z-[20]">
      {charElements}
    </div>
  );
}

export function LoginPage() {
  const { login, isLoggedIn } = useAuth();
  const { x, y } = useMousePosition();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);

  const glowRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  if (isLoggedIn && !animating) return <Navigate to="/" />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setAnimating(true);
    try {
      await login(username, password);
      setTimeout(() => {
        setShowWorkspace(true);
        setTimeout(() => navigate('/'), 300);
      }, 2300);
    } catch (err: any) {
      setError(err.message || 'Login failed');
      setLoading(false);
      setAnimating(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#0a0a0f]">
      <div className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(79,209,197,0.05) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }} />

      {!animating && (
        <div className="pointer-events-none fixed inset-0 z-[1] overflow-hidden" style={{ opacity: 0.025 }}>
          <PhilosophyText />
        </div>
      )}
      {!animating && (
        <div className="pointer-events-none fixed inset-0 z-[2] overflow-hidden"
          style={{
            WebkitMaskImage: `radial-gradient(circle 300px at ${x}px ${y}px, black 0% 25%, transparent 70%)`,
            maskImage: `radial-gradient(circle 300px at ${x}px ${y}px, black 0% 25%, transparent 70%)`,
            filter: 'drop-shadow(0 0 12px rgba(79,209,197,0.3))',
          }}>
          <PhilosophyText />
        </div>
      )}

      {animating && (
        <>
          <ConvergeAnimationLayer glowRef={glowRef} workspaceRef={workspaceRef} overlayRef={overlayRef} />
          <div ref={glowRef} />
          <div ref={overlayRef} className="fixed inset-0 z-[30] bg-[#0a0a0f] pointer-events-none" style={{ opacity: 0 }} />
          {showWorkspace && (
            <div ref={workspaceRef} className="fixed inset-0 z-[25]" style={{ opacity: 0 }}>
              <ChatPage />
            </div>
          )}
        </>
      )}

      {!animating && (
        <div className="relative z-10 flex items-center justify-center min-h-screen">
          <div className="w-full max-w-sm px-4">
            <div className="text-center mb-10">
              <h1 className="text-5xl font-bold mb-3 bg-gradient-to-r from-[#4fd1c5] via-[#81e6d9] to-[#8b5cf6] bg-clip-text text-transparent">
                AgentHub
              </h1>
              <p className="text-[rgba(203,213,225,0.55)] text-sm">智能协作中枢</p>
            </div>
            <div className="rounded-2xl p-8 bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="block text-sm text-[rgba(203,213,225,0.7)] mb-1.5">Username</label>
                  <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[rgba(248,250,252,0.94)] placeholder-[rgba(148,163,184,0.3)] focus:outline-none focus:border-[#4fd1c5] focus:ring-1 focus:ring-[rgba(79,209,197,0.3)] transition"
                    autoFocus />
                </div>
                <div>
                  <label className="block text-sm text-[rgba(203,213,225,0.7)] mb-1.5">Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[rgba(248,250,252,0.94)] placeholder-[rgba(148,163,184,0.3)] focus:outline-none focus:border-[#4fd1c5] focus:ring-1 focus:ring-[rgba(79,209,197,0.3)] transition" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[rgba(148,163,184,0.4)] hover:text-[rgba(203,213,225,0.7)] transition">
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                {error && <p className="text-sm text-red-400 bg-[rgba(239,68,68,0.08)] px-3 py-2 rounded-lg">{error}</p>}
                <button type="submit" disabled={loading}
                  className="w-full px-4 py-2.5 rounded-lg font-medium bg-gradient-to-r from-[#4fd1c5] to-[#38b2a0] text-[#0a0a0f] hover:from-[#38b2a0] hover:to-[#2c9e8e] shadow-[0_4px_16px_rgba(79,209,197,0.2)] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed">
                  {loading ? 'Signing in...' : 'Sign in'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
