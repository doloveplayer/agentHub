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

  const login = async (username: string, password: string) => {
    const res = await api.login(username, password);
    setToken(res.token);
    // fetch full user profile
    const me = await api.getMe();
    setUser(me);
  };

  const register = async (username: string, password: string) => {
    const res = await api.register(username, password);
    setToken(res.token);
    const me = await api.getMe();
    setUser(me);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  return { isLoggedIn, user, token, login, register, logout };
}
