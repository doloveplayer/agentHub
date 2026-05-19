import { useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';

export function useAuth() {
  const { token, user, setToken, setUser } = useAppStore();
  const isLoggedIn = !!token && !!user;

  // On mount, verify token by fetching /me
  useEffect(() => {
    if (token && !user) {
      api.getMe()
        .then(setUser)
        .catch(() => setToken(null));
    }
  }, [token]);

  const login = () => {
    window.location.href = 'http://localhost:3000/api/auth/github';
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  // Parse token from callback URL
  const handleCallback = () => {
    const params = new URLSearchParams(window.location.search);
    const cbToken = params.get('token');
    if (cbToken) {
      setToken(cbToken);
      window.history.replaceState({}, '', '/');
    }
  };

  return { isLoggedIn, user, token, login, logout, handleCallback };
}
