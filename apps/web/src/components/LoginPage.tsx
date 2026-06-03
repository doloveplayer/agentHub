import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Eye, EyeOff, GitBranch, MessageSquare, Layers } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useMousePosition } from '../hooks/useMousePosition';

const FEATURES = [
  { icon: GitBranch, label: 'Multi-Agent Orchestration' },
  { icon: MessageSquare, label: 'Real-time Streaming' },
  { icon: Layers, label: 'Artifact Preview & Edit' },
];

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
          backgroundImage:
            'radial-gradient(circle, rgba(79,209,197,0.07) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      {/* Spotlight following mouse */}
      <div
        className="pointer-events-none fixed inset-0 z-[1]"
        style={{
          background: `radial-gradient(600px circle at ${x}px ${y}px, rgba(79,209,197,0.07), transparent 60%)`,
        }}
      />

      {/* Secondary glow — purple accent, offset from mouse */}
      <div
        className="pointer-events-none fixed inset-0 z-[1]"
        style={{
          background: `radial-gradient(400px circle at ${x + 200}px ${y + 150}px, rgba(139,92,246,0.04), transparent 60%)`,
        }}
      />

      {/* Content */}
      <div className="relative z-10 w-full max-w-sm px-4">
        {/* Brand header */}
        <div className="text-center mb-10">
          <h1 className="text-5xl font-bold mb-3 bg-gradient-to-r from-[#4fd1c5] via-[#81e6d9] to-[#8b5cf6] bg-clip-text text-transparent">
            AgentHub
          </h1>
          <p className="text-[rgba(203,213,225,0.7)] text-sm leading-relaxed">
            Smart Hub for Multi-Agent Collaboration
          </p>
        </div>

        {/* Feature tags */}
        <div className="flex justify-center gap-3 mb-8">
          {FEATURES.map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs
                         bg-[rgba(79,209,197,0.06)] border border-[rgba(79,209,197,0.15)]
                         text-[rgba(203,213,225,0.65)]"
            >
              <Icon className="w-3.5 h-3.5 text-[#4fd1c5]" />
              <span>{label}</span>
            </div>
          ))}
        </div>

        {/* Login card — glassmorphism */}
        <div
          className="rounded-2xl p-8
                     bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)]
                     backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm text-[rgba(203,213,225,0.7)] mb-1.5">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg
                           bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)]
                           text-[rgba(248,250,252,0.94)] placeholder-[rgba(148,163,184,0.3)]
                           focus:outline-none focus:border-[#4fd1c5] focus:ring-1 focus:ring-[rgba(79,209,197,0.3)]
                           transition"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-[rgba(203,213,225,0.7)] mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 pr-10 rounded-lg
                             bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)]
                             text-[rgba(248,250,252,0.94)] placeholder-[rgba(148,163,184,0.3)]
                             focus:outline-none focus:border-[#4fd1c5] focus:ring-1 focus:ring-[rgba(79,209,197,0.3)]
                             transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2
                             text-[rgba(148,163,184,0.4)] hover:text-[rgba(203,213,225,0.7)]
                             transition"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-400 bg-[rgba(239,68,68,0.08)] px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2.5 rounded-lg font-medium
                         bg-gradient-to-r from-[#4fd1c5] to-[#38b2a0]
                         text-[#0a0a0f] hover:from-[#38b2a0] hover:to-[#2c9e8e]
                         shadow-[0_4px_16px_rgba(79,209,197,0.2)]
                         transition-all duration-200
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>

        {/* Footer hint */}
        <p className="text-center text-xs text-[rgba(148,163,184,0.25)] mt-8">
          AI Agent Collaboration Hub
        </p>
      </div>
    </div>
  );
}
