import type { SendResponse } from '@agenthub/shared';

const BASE_URL = '/api';

function getToken(): string | null {
  return localStorage.getItem('agenthub_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...((options.headers as Record<string, string>) ?? {}) };
  // Only set Content-Type for non-FormData bodies (let browser set multipart boundary for FormData)
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
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
  login: (username: string, password: string) =>
    request<{ token: string; userId: string; username: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, password: string) =>
    request<{ token: string; userId: string; username: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  getMe: () => request<any>('/auth/me'),

  getSessions: (includeArchived?: boolean) => {
    const query = includeArchived ? '?includeArchived=true' : '';
    return request<any[]>(`/sessions${query}`);
  },

  createSession: (body?: { type?: string; agentIds?: string[]; customAgent?: { name: string; displayName: string; description: string; systemPrompt: string } }) =>
    request<any>('/sessions', { method: 'POST', body: JSON.stringify(body ?? {}) }),

  getSession: (id: string) => request<any>(`/sessions/${id}`),

  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),

  updateSession: (id: string, body: { title?: string; permissionMode?: string; pinned?: boolean; archived?: boolean }) =>
    request<any>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  sendMessage: (sessionId: string, content: string, mentions?: { agentId: string; agentName: string; subPrompt: string }[]) =>
    request<SendResponse>('/chat/send', {
      method: 'POST',
      body: JSON.stringify({ sessionId, content, mentions }),
    }),

  getAgents: () => request<any[]>('/agents'),

  updateAgent: (id: string, body: { displayName?: string; description?: string; systemPrompt?: string; skills?: import('@agenthub/shared').SkillDef[] | null }) =>
    request<any>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  validateSkillFile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<import('@agenthub/shared').SkillValidationResult>('/agents/skills/validate', {
      method: 'POST',
      body: formData,
    });
  },

  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),

  createAgentFromMd: (content: string, providerConfig?: Record<string, unknown>) =>
    request<any>('/agents/from-md', { method: 'POST', body: JSON.stringify({ content, providerConfig }) }),

  getProviderConfigs: () => request<Record<string, { apiKey?: string; endpoint?: string }>>('/agents/provider-configs'),

  saveProviderConfigs: (configs: Record<string, { apiKey?: string; endpoint?: string }>) =>
    request<{ success: boolean }>('/agents/provider-configs', { method: 'PUT', body: JSON.stringify(configs) }),

  getWorkspaceTree: (sessionId: string) => request<{ tree: any[]; workspaceTree: any[]; sandboxDir: string; workspaceDir: string | null }>(`/workspace/${sessionId}/tree`),

  getWorkspaceFile: (sessionId: string, path: string) => request<any>(`/workspace/${sessionId}/file?path=${encodeURIComponent(path)}`),

  updateWorkspaceFile: (sessionId: string, path: string, content: string) =>
    request<{ path: string; size: number; modifiedAt: string }>(`/workspace/${sessionId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),

  downloadWorkspacePath: async (sessionId: string, path: string) => {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE_URL}/workspace/${sessionId}/download?path=${encodeURIComponent(path)}`, { headers });
    if (!res.ok) {
      if (res.status === 401) {
        localStorage.removeItem('agenthub_token');
        window.location.href = '/login';
        throw new Error('Session expired — redirecting to login');
      }
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? 'Download failed');
    }
    const disposition = res.headers.get('content-disposition') || '';
    const name = disposition.match(/filename="([^"]+)"/)?.[1];
    return { blob: await res.blob(), filename: name };
  },

  getHtmlPreviewUrl: (sessionId: string, filePath: string) => {
    const token = getToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    return `${BASE_URL}/workspace/${sessionId}/html-preview?path=${encodeURIComponent(filePath)}${tokenParam}`;
  },
  getWorkspaceChanges: (sessionId: string) => request<{ changes: string[] }>(`/workspace/${sessionId}/changes`),

  // Workspace configuration
  getSessionWorkspace: (sessionId: string) =>
    request<{ path: string | null; mode: string; writePermission: string }>(`/sessions/${sessionId}/workspace`),

  setSessionWorkspace: (sessionId: string, config: { path: string; mode?: string; writePermission?: string }) =>
    request<{ success: boolean; path: string; mode: string; writePermission: string }>(`/sessions/${sessionId}/workspace`, {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  browseDirectory: (dirPath: string) =>
    request<{ path: string; dirs: { name: string; path: string }[] }>(`/workspace/browse?path=${encodeURIComponent(dirPath)}`),

  getDiffFiles: (sessionId: string, baseVersionId?: string) =>
    request<{ files: any[] }>(`/diff/${sessionId}/files${baseVersionId ? `?baseVersionId=${encodeURIComponent(baseVersionId)}` : ''}`),

  getFileDiff: (sessionId: string, path: string, baseVersionId?: string) =>
    request<{ file: any }>(`/diff/${sessionId}/file?path=${encodeURIComponent(path)}${baseVersionId ? `&baseVersionId=${encodeURIComponent(baseVersionId)}` : ''}`),

  getVersions: (sessionId: string) => request<{ versions: any[] }>(`/diff/${sessionId}/versions`),

  createVersion: (sessionId: string, body: { agentName?: string; summary?: string }) =>
    request<{ version: any }>(`/diff/${sessionId}/versions`, { method: 'POST', body: JSON.stringify(body) }),

  diffVersions: (sessionId: string, from: string, to: string, path?: string) =>
    request<{ diff: any }>(`/diff/${sessionId}/versions/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${path ? `&path=${encodeURIComponent(path)}` : ''}`),

  restoreVersion: (sessionId: string, versionId: string) =>
    request<{ ok: boolean }>(`/diff/${sessionId}/restore`, { method: 'POST', body: JSON.stringify({ versionId }) }),

  acceptDiffFile: (sessionId: string, path: string) =>
    request<{ ok: boolean }>(`/diff/${sessionId}/accept`, { method: 'POST', body: JSON.stringify({ path }) }),

  rejectDiffFile: (sessionId: string, path: string, baseVersionId?: string) =>
    request<{ ok: boolean }>(`/diff/${sessionId}/reject`, { method: 'POST', body: JSON.stringify({ path, baseVersionId }) }),

  getPreviewPorts: (sessionId: string) => request<{ ports: number[] }>(`/preview/${sessionId}/ports`),

  forwardPreviewPort: (sessionId: string, port: number) =>
    request<{ containerPort: number; hostPort: number; url: string; proxyUrl: string }>(`/preview/${sessionId}/forward`, {
      method: 'POST',
      body: JSON.stringify({ port }),
    }),

  capturePreviewScreenshot: (sessionId: string, url: string) =>
    request<{ image: string; capturedAt: number }>(`/preview/${sessionId}/screenshot`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  generateDeployConfig: (sessionId: string, body: { appName?: string; buildCommand?: string; startCommand?: string; env?: string[] }) =>
    request<{ files: string[] }>(`/deploy/${sessionId}/config`, { method: 'POST', body: JSON.stringify(body) }),

  deployToPlatform: (sessionId: string, body: { target: 'docker' | 'vercel' | 'cloudflare'; production?: boolean; confirmPhrase?: string }) =>
    request<{ deploymentId: string; status: string }>(`/deploy/${sessionId}/run`, { method: 'POST', body: JSON.stringify(body) }),

  rollbackDeployment: (sessionId: string) =>
    request<{ ok: boolean; output: string }>(`/deploy/${sessionId}/rollback`, { method: 'POST' }),

  runTests: (sessionId: string, command?: string) =>
    request<{ report: any; exitCode: number }>(`/test/${sessionId}/run`, { method: 'POST', body: JSON.stringify({ command }) }),

  generateTestPrompt: (sessionId: string, target?: string) =>
    request<{ prompt: string }>(`/test/${sessionId}/generate`, { method: 'POST', body: JSON.stringify({ target }) }),

  runSecurityAudit: (sessionId: string) =>
    request<{ report: any; exitCode: number }>(`/security/${sessionId}/audit`, { method: 'POST' }),

  upgradeDependencies: (sessionId: string, packageName?: string) =>
    request<{ output: string; exitCode: number }>(`/security/${sessionId}/upgrade`, { method: 'POST', body: JSON.stringify({ packageName }) }),

  createReviewReport: (sessionId: string, content: string) =>
    request<{ report: any }>(`/review/${sessionId}/report`, { method: 'POST', body: JSON.stringify({ content }) }),

  deleteMessage: (messageId: string) =>
    request<{ ok: boolean }>(`/chat/messages/${messageId}`, { method: 'DELETE' }),

  addAgentToSession: (sessionId: string, agentId: string) =>
    request<{ agentId: string; name: string; displayName: string }>(`/sessions/${sessionId}/agents`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    }),

  addSessionAgents: (sessionId: string, agentIds: string[]) =>
    request<{ added: string[] }>(`/sessions/${sessionId}/agents`, {
      method: 'POST',
      body: JSON.stringify({ agentIds }),
    }),

  removeAgentFromSession: (sessionId: string, agentId: string) =>
    request<void>(`/sessions/${sessionId}/agents/${agentId}`, { method: 'DELETE' }),

  getWorkspace: (sessionId: string) =>
    request<{ path: string | null; mode: string }>(`/sessions/${sessionId}/workspace`),

  setWorkspace: (sessionId: string, workspacePath: string, mode?: string) =>
    request<{ success: boolean; path: string; mode: string }>(`/sessions/${sessionId}/workspace`, {
      method: 'POST',
      body: JSON.stringify({ path: workspacePath, mode }),
    }),

  getSessionAgentConfig: (sessionId: string, agentId: string) =>
    request<{ sessionId: string; agentId: string; systemPromptOverride: string | null; globalSystemPrompt: string }>(
      `/sessions/${sessionId}/agents/${agentId}`
    ),

  updateSessionAgentConfig: (sessionId: string, agentId: string, systemPromptOverride?: string) =>
    request<{ sessionId: string; agentId: string; systemPromptOverride: string | null }>(
      `/sessions/${sessionId}/agents/${agentId}`,
      { method: 'PATCH', body: JSON.stringify({ systemPromptOverride }) }
    ),

  createQuoteReference: (data: {
    sourceMessageId: string;
    selectionText: string;
    sourceType: string;
    contextMeta?: Record<string, unknown>;
    sessionId: string;
  }) =>
    request<{ id: string }>('/quote-references', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getQuoteReferences: (messageId: string) =>
    request<{ quotedFrom: any[]; quotedBy: any[] }>(`/quote-references?messageId=${encodeURIComponent(messageId)}`),

  getCommLog: (sessionId: string) =>
    request<{ entries: any[] }>(`/sessions/${sessionId}/comm-log`),
};
