import { useSettingsStore } from '../store/settingsStore';

const API = '/api/settings';

export function useSettings() {
  const store = useSettingsStore();

  const fetchSettings = async () => {
    store.setLoading(true);
    try {
      const token = localStorage.getItem('agenthub_token');
      const headers = { Authorization: `Bearer ${token}` };

      const [userRes, runtimeRes] = await Promise.all([
        fetch(`${API}/user`, { headers }),
        fetch(`${API}/runtime`, { headers }),
      ]);

      if (userRes.ok) store.setUser(await userRes.json());
      if (runtimeRes.ok) {
        const runtime = await runtimeRes.json();
        store.setRuntime(runtime);
        store.setAdmin(runtime.isAdmin === true);
      }
    } catch (err) {
      console.error('[settings] fetch failed:', err);
    } finally {
      store.setLoading(false);
    }
  };

  const saveUserSettings = async (data: Record<string, unknown>) => {
    const token = localStorage.getItem('agenthub_token');
    const res = await fetch(`${API}/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      store.setUser(data as any);
      return true;
    }
    return false;
  };

  const saveRuntimeConfig = async (data: Record<string, number>) => {
    const token = localStorage.getItem('agenthub_token');
    const res = await fetch(`${API}/runtime`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const json = await res.json();
      store.setRuntime(json);
      return true;
    }
    return false;
  };

  const uploadAvatar = async (file: File): Promise<string | null> => {
    const token = localStorage.getItem('agenthub_token');
    const form = new FormData();
    form.append('avatar', file);
    const res = await fetch('/api/avatar/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (res.ok) {
      const json = await res.json();
      store.setUser({ avatarUrl: json.url });
      return json.url;
    }
    return null;
  };

  return { ...store, fetchSettings, saveUserSettings, saveRuntimeConfig, uploadAvatar };
}
