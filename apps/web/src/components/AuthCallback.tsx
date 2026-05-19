import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function AuthCallback() {
  const { handleCallback, token } = useAuth();

  useEffect(() => {
    handleCallback();
  }, []);

  if (token) return <Navigate to="/" />;

  return (
    <div className="flex items-center justify-center min-h-screen text-gray-400">
      Authenticating...
    </div>
  );
}
