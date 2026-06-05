import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { LoginCanvas } from './LoginCanvas';

const BRAND_WORDS = ['策划', '编码', '审查', '部署', '测试'];

function WordRotate() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % BRAND_WORDS.length);
    }, 2200);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="inline-block relative min-w-[3em] h-[1.2em] overflow-hidden align-middle">
      {BRAND_WORDS.map((word, i) => (
        <span
          key={word}
          className="absolute inset-0 flex items-center justify-center transition-all duration-500"
          style={{
            opacity: i === index ? 1 : 0,
            transform: `translateY(${i === index ? 0 : '-10px'})`,
            filter: i === index ? 'blur(0)' : 'blur(4px)',
          }}
        >
          {word}
        </span>
      ))}
    </span>
  );
}

export function LoginPage() {
  const { login, isLoggedIn } = useAuth();
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
    <div className="relative flex items-center justify-center min-h-screen overflow-hidden bg-hub-root">
      {/* Canvas particle network background */}
      <LoginCanvas />

      {/* Content */}
      <div className="relative z-10 w-full max-w-sm px-4">
        {/* Brand header with word rotation */}
        <div className="text-center mb-6">
          <h1 className="text-5xl font-bold mb-3 bg-gradient-to-r from-teal-400 via-teal-300 to-purple-400 bg-clip-text text-transparent">
            AgentHub
          </h1>
          <p className="text-hub-tertiary text-sm">
            让 AI <WordRotate />更简单
          </p>
        </div>

        {/* Glass login card */}
        <div className="rounded-2xl p-8 glass-surface-heavy border border-hub-border shadow-[0_4px_24px_rgba(0,0,0,0.06)]">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm text-hub-secondary mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-hub-input border border-hub-border text-hub-primary placeholder:text-hub-muted focus:outline-none focus:border-hub-accent focus:ring-1 focus:ring-hub-accent/30 transition"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm text-hub-secondary mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 pr-10 rounded-lg bg-hub-input border border-hub-border text-hub-primary placeholder:text-hub-muted focus:outline-none focus:border-hub-accent focus:ring-1 focus:ring-hub-accent/30 transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-hub-muted hover:text-hub-secondary transition"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-hub-danger bg-hub-danger/10 px-3 py-2 rounded-lg">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2.5 rounded-lg font-medium bg-teal-500 text-white hover:bg-teal-600 shadow-[0_4px_16px_rgba(20,184,166,0.15)] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
