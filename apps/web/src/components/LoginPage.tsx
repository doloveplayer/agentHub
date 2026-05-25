import { Github } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export function LoginPage() {
  const { login, isLoggedIn } = useAuth();
  if (isLoggedIn) return null; // Will redirect

  return (
    <div className="flex items-center justify-center min-h-screen bg-hub-root">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-hub-primary mb-2">AgentHub</h1>
        <p className="text-hub-tertiary mb-8">IM-powered AI agent collaboration</p>
        <button
          onClick={login}
          className="inline-flex items-center gap-2 px-6 py-3 bg-hub-accent text-white rounded-lg hover:bg-hub-accent-hover transition font-medium"
        >
          <Github className="w-5 h-5" />
          Sign in with GitHub
        </button>
      </div>
    </div>
  );
}
