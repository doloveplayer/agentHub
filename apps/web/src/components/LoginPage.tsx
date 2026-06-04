import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useMousePosition } from '../hooks/useMousePosition';

const CX = 44, CY = 50;

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
          <span
            key={s.text}
            className={`absolute ${s.size} font-extrabold tracking-wider whitespace-nowrap`}
            style={{ left: s.x, top: s.y, color: '#4fd1c5', opacity: 1 - (dist / 42) * 0.6 }}
          >
            {s.text}
          </span>
        );
      })}
    </>
  );
}

export function LoginPage() {
  const { login, isLoggedIn } = useAuth();
  const { x, y } = useMousePosition();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (isLoggedIn) return <Navigate to="/" />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex items-center justify-center min-h-screen overflow-hidden bg-[#0a0a0f]">
      {/* Dot grid background */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(79,209,197,0.05) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Dim philosophy text */}
      <div
        className="pointer-events-none fixed inset-0 z-[1] overflow-hidden"
        style={{ opacity: 0.025 }}
      >
        <PhilosophyText />
      </div>

      {/* Spotlight reveal */}
      <div
        className="pointer-events-none fixed inset-0 z-[2] overflow-hidden"
        style={{
          WebkitMaskImage: `radial-gradient(circle 300px at ${x}px ${y}px, black 0% 25%, transparent 70%)`,
          maskImage: `radial-gradient(circle 300px at ${x}px ${y}px, black 0% 25%, transparent 70%)`,
          filter: 'drop-shadow(0 0 12px rgba(79,209,197,0.3))',
        }}
      >
        <PhilosophyText />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-sm px-4">
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
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[rgba(248,250,252,0.94)] placeholder-[rgba(148,163,184,0.3)] focus:outline-none focus:border-[#4fd1c5] focus:ring-1 focus:ring-[rgba(79,209,197,0.3)] transition"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-[rgba(203,213,225,0.7)] mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[rgba(248,250,252,0.94)] placeholder-[rgba(148,163,184,0.3)] focus:outline-none focus:border-[#4fd1c5] focus:ring-1 focus:ring-[rgba(79,209,197,0.3)] transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[rgba(148,163,184,0.4)] hover:text-[rgba(203,213,225,0.7)] transition"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-[rgba(239,68,68,0.08)] px-3 py-2 rounded-lg">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2.5 rounded-lg font-medium bg-gradient-to-r from-[#4fd1c5] to-[#38b2a0] text-[#0a0a0f] hover:from-[#38b2a0] hover:to-[#2c9e8e] shadow-[0_4px_16px_rgba(79,209,197,0.2)] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
