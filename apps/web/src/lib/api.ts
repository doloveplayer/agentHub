import type { SendResponse } from '@agenthub/shared';

const BASE_URL = '/api';

function getToken(): string | null {
  return localStorage.getItem('agenthub_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    // On 401, clear stale token and redirect to login
    if (res.status === 401) {
      localStorage.removeItem('agenthub_token');
      window.location.href = '/login';
      throw new Error('Session expired — redirecting to login');
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getMe: () => request<any>('/auth/me'),

  getSessions: () => request<any[]>('/sessions'),

  createSession: (body?: { type?: string; agentIds?: string[] }) =>
    request<any>('/sessions', { method: 'POST', body: JSON.stringify(body ?? {}) }),

  getSession: (id: string) => request<any>(`/sessions/${id}`),

  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),

  sendMessage: (sessionId: string, content: string, mentions?: { agentId: string; agentName: string; subPrompt: string }[]) =>
    request<SendResponse>('/chat/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, content, mentions }),
    }),

  getAgents: () => request<any[]>('/agents'),

  getWorkspaceTree: (sessionId: string) => request<{ tree: any[] }>(`/workspace/${sessionId}/tree`),

  getWorkspaceFile: (sessionId: string, path: string) => request<any>(`/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`),

  getWorkspaceChanges: (sessionId: string) => request<{ changes: string[] }>(`/workspace/${sessionId}/changes`),
};