import { create } from 'zustand';

export interface UserSettings {
  theme: string;
  notificationsEnabled: boolean;
  avatarUrl: string;
}

export interface RuntimeAgentConfig {
  maxConcurrent: number;
  timeoutMs: number;
  queueTimeoutMs: number;
  perSessionMax: number;
}

interface SettingsState {
  user: UserSettings;
  runtime: RuntimeAgentConfig | null;
  isAdmin: boolean;
  loading: boolean;
  setUser: (s: Partial<UserSettings>) => void;
  setRuntime: (c: RuntimeAgentConfig) => void;
  setAdmin: (v: boolean) => void;
  setLoading: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  user: { theme: 'dark', notificationsEnabled: true, avatarUrl: '' },
  runtime: null,
  isAdmin: false,
  loading: false,
  setUser: (s) => set((st) => ({ user: { ...st.user, ...s } })),
  setRuntime: (c) => set({ runtime: c }),
  setAdmin: (v) => set({ isAdmin: v }),
  setLoading: (v) => set({ loading: v }),
}));
