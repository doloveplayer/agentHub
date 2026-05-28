# User Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a settings page where users can configure their avatar and admins can adjust runtime agent parameters (concurrency, timeouts).

**Architecture:** Backend refactors `config.ts` from frozen const to mutable runtime config with a `RuntimeConfig` registry, persisted to `GlobalConfig` DB table (survives restart). A new `UserSettings` model stores per-user preferences. REST API endpoints serve GET/PUT for user settings, admin-only PUT for runtime config. Frontend adds a settings gear icon in the session header, opening a side panel with avatar upload and config forms.

**Tech Stack:** Hono API routes, Prisma migration, React + Zustand store, file upload via multipart

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/api/prisma/schema.prisma` | New `UserSettings` model + migration |
| `apps/api/src/config.ts` | Refactor: mutable `RuntimeConfig` class wrapping env defaults |
| `apps/api/src/routes/settings.ts` | GET/PUT `/api/settings/user`, PUT `/api/settings/runtime` |
| `apps/api/src/routes/avatar.ts` | POST `/api/avatar/upload` multipart handler |
| `apps/api/src/index.ts` | Register new routes, serve static `.uploads/` |
| `apps/web/src/components/SettingsPanel.tsx` | Side panel with tabs: Profile / Agent Config |
| `apps/web/src/components/AvatarUpload.tsx` | Drag-drop avatar upload with preview |
| `apps/web/src/components/RuntimeConfigForm.tsx` | Admin-only form for global parameters |
| `apps/web/src/components/NavBar.tsx` | Add settings gear icon |
| `apps/web/src/store/settingsStore.ts` | Zustand store for settings state |
| `apps/web/src/hooks/useSettings.ts` | Hook: fetch/save settings |

---

### Task 1: DB Migration — UserSettings model

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add model)
- Create: migration via `npx prisma migrate dev`

- [ ] **Step 1: Add `UserSettings` model and `settings` field to User**

Append to `apps/api/prisma/schema.prisma`:

```prisma
model UserSettings {
  id        String   @id @default(uuid())
  userId    String   @unique
  user      User     @relation(fields: [userId], references: [id])
  theme     String   @default("dark")
  notificationsEnabled Boolean @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model GlobalConfig {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 2: Run migration**

```bash
cd apps/api && npx prisma migrate dev --name add_user_settings
```

Expected: migration created, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat: add UserSettings model with theme and notification prefs"
```

---

### Task 2: Refactor config.ts — Mutable RuntimeConfig

**Files:**
- Modify: `apps/api/src/config.ts`

Currently `config` is `as const` frozen at import time. We need runtime-mutable properties for agent concurrency/timeout while preserving env-var defaults.

- [ ] **Step 1: Create `RuntimeConfig` class**

Replace the frozen config with a class that reads env vars as defaults but allows runtime override:

```typescript
// apps/api/src/config.ts — refactor bottom section

class RuntimeAgentConfig {
  private _maxConcurrent: number;
  private _timeoutMs: number;
  private _queueTimeoutMs: number;
  private _perSessionMax: number;

  constructor() {
    this._maxConcurrent = optionalInt('MAX_CONCURRENT_AGENTS', 2);
    this._timeoutMs = optionalInt('AGENT_TIMEOUT_MS', 300_000);
    this._queueTimeoutMs = optionalInt('AGENT_QUEUE_TIMEOUT_MS', 120_000);
    this._perSessionMax = optionalInt('AGENT_PER_SESSION_MAX', 8);
  }

  /** Load persisted values from DB, falling back to env vars */
  async loadPersisted(prisma: any) {
    try {
      const rows = await prisma.globalConfig.findMany({
        where: { key: { in: ['maxConcurrent', 'timeoutMs', 'queueTimeoutMs', 'perSessionMax'] } },
      });
      for (const row of rows) {
        const val = Number(row.value);
        if (!isNaN(val)) (this as any)[`_${row.key}`] = val;
      }
      console.log('[config] Loaded persisted runtime config:', this.toJSON());
    } catch { /* table may not exist yet — use env defaults */ }
  }

  /** Persist a single key to DB */
  private async persist(prisma: any, key: string, value: number) {
    try {
      await prisma.globalConfig.upsert({
        where: { key },
        create: { key, value: String(value) },
        update: { value: String(value) },
      });
    } catch { /* best-effort */ }
  }

  async setMaxConcurrent(prisma: any, v: number) {
    if (v > 0 && v <= 20) { this._maxConcurrent = v; await this.persist(prisma, 'maxConcurrent', v); }
  }
  async setTimeoutMs(prisma: any, v: number) {
    if (v >= 10_000 && v <= 3_600_000) { this._timeoutMs = v; await this.persist(prisma, 'timeoutMs', v); }
  }
  async setQueueTimeoutMs(prisma: any, v: number) {
    if (v >= 10_000 && v <= 1_800_000) { this._queueTimeoutMs = v; await this.persist(prisma, 'queueTimeoutMs', v); }
  }
  async setPerSessionMax(prisma: any, v: number) {
    if (v > 0 && v <= 50) { this._perSessionMax = v; await this.persist(prisma, 'perSessionMax', v); }
  }

  // Sync setters (no DB — for test compatibility and backward compat)
  get maxConcurrent(): number { return this._maxConcurrent; }
  set maxConcurrent(v: number) {
    if (v > 0 && v <= 20) this._maxConcurrent = v;
  }

  get timeoutMs(): number { return this._timeoutMs; }
  set timeoutMs(v: number) {
    if (v >= 10_000 && v <= 3_600_000) this._timeoutMs = v;
  }

  get queueTimeoutMs(): number { return this._queueTimeoutMs; }
  set queueTimeoutMs(v: number) {
    if (v >= 10_000 && v <= 1_800_000) this._queueTimeoutMs = v;
  }

  get perSessionMax(): number { return this._perSessionMax; }
  set perSessionMax(v: number) {
    if (v > 0 && v <= 50) this._perSessionMax = v;
  }

  toJSON() {
    return {
      maxConcurrent: this._maxConcurrent,
      timeoutMs: this._timeoutMs,
      queueTimeoutMs: this._queueTimeoutMs,
      perSessionMax: this._perSessionMax,
    };
  }
}

class RuntimeConfig {
  agent = new RuntimeAgentConfig();
  // ... other sections (database, jwt, github, sandbox, frontendUrl) stay frozen
}

export const runtimeConfig = new RuntimeConfig();

// Keep the original frozen config for non-agent settings
export const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  database: { url: required('DATABASE_URL') },
  jwt: { secret: required('JWT_SECRET'), expiresIn: '7d' as const },
  github: {
    clientId: required('GITHUB_CLIENT_ID'),
    clientSecret: required('GITHUB_CLIENT_SECRET'),
    callbackUrl: required('GITHUB_CALLBACK_URL'),
    allowedUsers: required('GITHUB_ALLOWED_USERS').split(',').map(s => s.trim()).filter(Boolean),
  },
  redis: { url: optional('REDIS_URL', '') },
  sandbox: {
    hostDockerSocket: optional('HOST_DOCKER_SOCKET', '/var/run/docker.sock'),
    image: optional('SANDBOX_IMAGE', 'agenthub-sandbox:latest'),
    root: optional('SANDBOXES_ROOT', resolve(PROJECT_ROOT, '.sandboxes')),
    soloMemoryMb: optionalInt('SOLO_SANDBOX_MEMORY_MB', 512),
    groupMemoryMb: optionalInt('GROUP_SANDBOX_MEMORY_MB', 2048),
  },
  frontendUrl: optional('FRONTEND_URL', 'http://localhost:5175'),
  agent: {
    get maxConcurrent() { return runtimeConfig.agent.maxConcurrent; },
    get timeoutMs() { return runtimeConfig.agent.timeoutMs; },
    get queueTimeoutMs() { return runtimeConfig.agent.queueTimeoutMs; },
    get perSessionMax() { return runtimeConfig.agent.perSessionMax; },
    provider: optional('AGENTHUB_AGENT_PROVIDER', optional('AGENT_PROVIDER', 'claude-code')),
    contextWindowTokens: optionalInt('AGENT_CONTEXT_WINDOW_TOKENS', 200_000),
  },
} as const;
```

**Why getters on the frozen `config.agent`**: All existing code uses `config.agent.maxConcurrent` etc. The getters delegate to `runtimeConfig`, so existing code works unchanged. Hot-reload through `runtimeConfig.agent.maxConcurrent = 4` is immediately visible.

- [ ] **Step 2: Verify existing code compiles**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean. All existing `config.agent.maxConcurrent` etc. still resolve through getters.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/config.ts
git commit -m "refactor: extract RuntimeConfig for hot-reloadable agent parameters"
```

---

### Task 3: Settings API Endpoints

**Files:**
- Create: `apps/api/src/routes/settings.ts`
- Modify: `apps/api/src/index.ts` (register routes)

- [ ] **Step 1: Create settings route file**

```typescript
// apps/api/src/routes/settings.ts
import { Hono } from 'hono';
import { prisma } from '../db/prisma.js';
import { runtimeConfig } from '../config.js';
import { verifyToken } from '../lib/jwt.js';

const app = new Hono();

// GET /api/settings/user — current user's settings
app.get('/user', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  const { userId } = verifyToken(auth);

  let userSettings = await prisma.userSettings.findUnique({ where: { userId } });
  if (!userSettings) {
    userSettings = await prisma.userSettings.create({
      data: { userId, theme: 'dark', notificationsEnabled: true },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { avatarUrl: true },
  });

  return c.json({
    theme: userSettings.theme,
    notificationsEnabled: userSettings.notificationsEnabled,
    avatarUrl: user?.avatarUrl ?? '',
  });
});

// PUT /api/settings/user — update user settings
app.put('/user', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  const { userId } = verifyToken(auth);

  const body = await c.req.json();
  const data: Record<string, unknown> = {};
  if (typeof body.theme === 'string') data.theme = body.theme;
  if (typeof body.notificationsEnabled === 'boolean') data.notificationsEnabled = body.notificationsEnabled;

  const settings = await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, theme: 'dark', notificationsEnabled: true, ...data },
    update: data,
  });

  // If avatarUrl provided, update User table
  if (typeof body.avatarUrl === 'string') {
    await prisma.user.update({ where: { id: userId }, data: { avatarUrl: body.avatarUrl } });
  }

  return c.json({ ok: true, settings });
});

// PUT /api/settings/runtime — update runtime agent config (admin only)
app.put('/runtime', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  const { userId } = verifyToken(auth);

  // Admin check: only the first allowed user can modify runtime settings
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { login: true } });
  const { config } = await import('../config.js');
  if (!config.github.allowedUsers.includes(user?.login ?? '')) {
    return c.json({ error: 'Admin only' }, 403);
  }

  const body = await c.req.json();
  if (typeof body.maxConcurrent === 'number') await runtimeConfig.agent.setMaxConcurrent(prisma, body.maxConcurrent);
  if (typeof body.timeoutMs === 'number') await runtimeConfig.agent.setTimeoutMs(prisma, body.timeoutMs);
  if (typeof body.queueTimeoutMs === 'number') await runtimeConfig.agent.setQueueTimeoutMs(prisma, body.queueTimeoutMs);
  if (typeof body.perSessionMax === 'number') await runtimeConfig.agent.setPerSessionMax(prisma, body.perSessionMax);

  console.log('[settings] Runtime config updated:', runtimeConfig.agent.toJSON());
  return c.json({ ok: true, config: runtimeConfig.agent.toJSON() });
});

// GET /api/settings/runtime — read current runtime config
app.get('/runtime', async (_c) => {
  return _c.json(runtimeConfig.agent.toJSON());
});

export default app;
```

- [ ] **Step 2: Register routes in index.ts**

In `apps/api/src/index.ts`, add after existing route imports:

```typescript
import settingsRoutes from './routes/settings.js';
import avatarRoutes from './routes/avatar.js';
```

And register:

```typescript
app.route('/api/settings', settingsRoutes);
app.route('/api/avatar', avatarRoutes);
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/settings.ts apps/api/src/index.ts
git commit -m "feat: add settings API endpoints for user prefs and runtime config"
```

---

### Task 4: Avatar Upload Endpoint

**Files:**
- Create: `apps/api/src/routes/avatar.ts`
- Modify: `apps/api/src/index.ts` (register static serving)

- [ ] **Step 1: Create avatar route**

```typescript
// apps/api/src/routes/avatar.ts
import { Hono } from 'hono';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { prisma } from '../db/prisma.js';
import { verifyToken } from '../lib/jwt.js';

const UPLOAD_DIR = resolve(process.cwd(), '.uploads', 'avatars');
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

const app = new Hono();

app.post('/upload', async (c) => {
  const auth = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!auth) return c.json({ error: 'Unauthorized' }, 401);
  const { userId } = verifyToken(auth);

  const body = await c.req.parseBody();
  const file = body.file as File | undefined;
  if (!file) return c.json({ error: 'No file' }, 400);
  if (file.size > MAX_SIZE) return c.json({ error: 'File too large (max 2MB)' }, 400);

  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return c.json({ error: 'Invalid file type' }, 400);
  }

  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  const filename = `${userId}.${ext}`;
  const filepath = resolve(UPLOAD_DIR, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  writeFileSync(filepath, buffer);

  const url = `/uploads/avatars/${filename}`;
  await prisma.user.update({ where: { id: userId }, data: { avatarUrl: url } });

  return c.json({ url });
});

export default app;
```

- [ ] **Step 2: Serve static uploads**

In `apps/api/src/index.ts`, add before `app.route` calls:

```typescript
import { serveStatic } from 'hono/serve-static';
app.use('/uploads/*', serveStatic({ root: './' }));
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/avatar.ts apps/api/src/index.ts
git commit -m "feat: add avatar upload endpoint with local file storage"
```

---

### Task 5: Settings Zustand Store + Hook

**Files:**
- Create: `apps/web/src/store/settingsStore.ts`
- Create: `apps/web/src/hooks/useSettings.ts`

- [ ] **Step 1: Create settings store**

```typescript
// apps/web/src/store/settingsStore.ts
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
```

- [ ] **Step 2: Create useSettings hook**

```typescript
// apps/web/src/hooks/useSettings.ts
import { useEffect } from 'react';
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

      if (userRes.ok) {
        const user = await userRes.json();
        store.setUser(user);
      }
      if (runtimeRes.ok) {
        const runtime = await runtimeRes.json();
        store.setRuntime(runtime);
      }
      // Admin check: runtime PUT returns 200 for admin, 403 for non-admin on update
      // We'll detect from runtime response — if 200, user can access
      store.setAdmin(runtimeRes.ok);
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
      store.setRuntime(json.config);
      return true;
    }
    return false;
  };

  const uploadAvatar = async (file: File): Promise<string | null> => {
    const token = localStorage.getItem('agenthub_token');
    const form = new FormData();
    form.append('file', file);
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
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/store/settingsStore.ts apps/web/src/hooks/useSettings.ts
git commit -m "feat: add settings store and hook for user prefs + runtime config"
```

---

### Task 6: AvatarUpload Component

**Files:**
- Create: `apps/web/src/components/AvatarUpload.tsx`

- [ ] **Step 1: Create component**

```tsx
// apps/web/src/components/AvatarUpload.tsx
import { useState, useRef } from 'react';
import { useSettings } from '../hooks/useSettings';

export function AvatarUpload() {
  const { user, uploadAvatar } = useSettings();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) { setError('File too large (max 2MB)'); return; }
    setUploading(true);
    setError('');
    const url = await uploadAvatar(file);
    setUploading(false);
    if (!url) setError('Upload failed');
  };

  const avatarSrc = user.avatarUrl || '';

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div
        className="w-20 h-20 rounded-full overflow-hidden border-2 border-hub cursor-pointer hover:opacity-80 transition relative"
        style={{ borderColor: 'var(--border-subtle)' }}
        onClick={() => inputRef.current?.click()}
      >
        {avatarSrc ? (
          <img src={avatarSrc} alt="avatar" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-2xl font-bold" style={{ background: 'var(--bg-raised)', color: 'var(--text-tertiary)' }}>
            ?
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      <span className="text-[11px] text-hub-muted">Click to change avatar (PNG/JPG, max 2MB)</span>
      {error && <span className="text-[11px] text-hub-danger">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/AvatarUpload.tsx
git commit -m "feat: add AvatarUpload component with drag-drop"
```

---

### Task 7: RuntimeConfigForm Component

**Files:**
- Create: `apps/web/src/components/RuntimeConfigForm.tsx`

- [ ] **Step 1: Create admin-only config form**

```tsx
// apps/web/src/components/RuntimeConfigForm.tsx
import { useState } from 'react';
import { useSettings } from '../hooks/useSettings';

const FIELDS = [
  { key: 'maxConcurrent', label: '全局并发上限', min: 1, max: 20, hint: '同时运行的最大 agent 数量' },
  { key: 'perSessionMax', label: '每会话 Agent 上限', min: 1, max: 50, hint: '单个会话中最多同时活跃的 agent' },
  { key: 'timeoutMs', label: 'Agent 超时 (秒)', min: 10, max: 3600, hint: '单个 agent 执行超时时间', fmt: (v: number) => v / 1000, parse: (v: number) => v * 1000 },
  { key: 'queueTimeoutMs', label: '队列超时 (秒)', min: 10, max: 1800, hint: '排队等待的最长时间', fmt: (v: number) => v / 1000, parse: (v: number) => v * 1000 },
];

export function RuntimeConfigForm() {
  const { runtime, isAdmin, saveRuntimeConfig } = useSettings();
  const [values, setValues] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);

  if (!isAdmin) {
    return <div className="text-caption text-hub-muted py-4">仅管理员可修改运行时参数</div>;
  }

  const current = runtime || { maxConcurrent: 2, timeoutMs: 300000, queueTimeoutMs: 120000, perSessionMax: 8 };

  const getVal = (key: string) => values[key] ?? (FIELDS.find(f => f.key === key)?.fmt?.(current[key as keyof typeof current] as number) ?? current[key as keyof typeof current] as number);

  const handleChange = (key: string, raw: number) => {
    const field = FIELDS.find(f => f.key === key);
    const val = field?.parse ? field.parse(raw) : raw;
    setValues(prev => ({ ...prev, [key]: val }));
  };

  const handleSave = async () => {
    const data: Record<string, number> = {};
    for (const f of FIELDS) {
      if (values[f.key] !== undefined) data[f.key] = values[f.key];
    }
    if (Object.keys(data).length === 0) return;
    const ok = await saveRuntimeConfig(data);
    if (ok) {
      setSaved(true);
      setValues({});
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="space-y-4 py-2">
      {FIELDS.map(f => (
        <div key={f.key} className="flex flex-col gap-1">
          <label className="text-caption text-hub-secondary font-medium">{f.label}</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={f.min}
              max={f.max}
              value={getVal(f.key)}
              onChange={e => handleChange(f.key, Number(e.target.value))}
              className="flex-1 bg-hub-raised border border-hub rounded px-3 py-1.5 text-caption text-hub-primary outline-none focus:border-hub-accent"
            />
          </div>
          <span className="text-[10px] text-hub-muted">{f.hint} (当前: {f.fmt ? f.fmt(current[f.key as keyof typeof current] as number) : String(current[f.key as keyof typeof current])})</span>
        </div>
      ))}
      <button
        onClick={handleSave}
        className="w-full py-2 rounded bg-hub-accent text-white text-caption font-medium hover:opacity-90 transition"
      >
        {saved ? 'Saved' : 'Save Runtime Config'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/RuntimeConfigForm.tsx
git commit -m "feat: add admin-only RuntimeConfigForm component"
```

---

### Task 8: SettingsPanel Component

**Files:**
- Create: `apps/web/src/components/SettingsPanel.tsx`

- [ ] **Step 1: Create side panel with tabs**

```tsx
// apps/web/src/components/SettingsPanel.tsx
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { AvatarUpload } from './AvatarUpload';
import { RuntimeConfigForm } from './RuntimeConfigForm';
import { useSettings } from '../hooks/useSettings';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'profile' | 'agent';

export function SettingsPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('profile');
  const { fetchSettings, loading } = useSettings();

  useEffect(() => {
    if (open) fetchSettings();
  }, [open]);

  if (!open) return null;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'profile', label: 'Profile' },
    { key: 'agent', label: 'Agent Config' },
  ];

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-80 bg-hub-surface border-l border-hub z-50 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-hub">
          <h2 className="text-body font-semibold text-hub-primary">Settings</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-tertiary">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-hub">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-2.5 text-caption font-medium transition ${
                tab === t.key
                  ? 'text-hub-accent border-b-2 border-hub-accent'
                  : 'text-hub-muted hover:text-hub-secondary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-hub-muted text-caption">Loading...</div>
          ) : tab === 'profile' ? (
            <AvatarUpload />
          ) : (
            <RuntimeConfigForm />
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/SettingsPanel.tsx
git commit -m "feat: add SettingsPanel with profile and agent config tabs"
```

---

### Task 9: Wire Settings Button in Session Header

**Files:**
- Modify: `apps/web/src/components/ChatView.tsx` (add to session header)
- Modify: `apps/web/src/pages/ChatPage.tsx` (add to mobile header)

- [ ] **Step 1: Add settings button in ChatView session header (desktop)**

In `apps/web/src/components/ChatView.tsx`, add the import:

```tsx
import { Settings } from 'lucide-react';
import { SettingsPanel } from './SettingsPanel';
```

Add state and button in the component:

```tsx
// Inside ChatView component, add:
const [settingsOpen, setSettingsOpen] = useState(false);
```

In the session header (around line 315, after the permission mode dropdown), add the settings gear:

```tsx
{/* Settings button */}
<button
  onClick={() => setSettingsOpen(true)}
  className="p-1.5 rounded hover:bg-hub-hover text-hub-tertiary transition shrink-0"
  title="Settings"
>
  <Settings className="w-3.5 h-3.5" />
</button>
```

And at the bottom of the ChatView JSX (before closing tag), add:

```tsx
<SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
```

- [ ] **Step 2: Add settings button in ChatPage mobile header**

In `apps/web/src/pages/ChatPage.tsx`, add import and state:

```tsx
import { Settings } from 'lucide-react';
import { SettingsPanel } from '../components/SettingsPanel';

// In ChatPage component:
const [settingsOpen, setSettingsOpen] = useState(false);
```

In the mobile header (line 48), add after the title:

```tsx
<button onClick={() => setSettingsOpen(true)} className="ml-auto p-1.5 rounded-md hover:bg-hub-hover">
  <Settings className="w-5 h-5 text-hub-tertiary" />
</button>
```

And at the bottom of ChatPage (before closing `</div>`), add:

```tsx
<SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/pages/ChatPage.tsx
git commit -m "feat: wire settings button in session header (desktop + mobile)"
```

---

### Task 10: Integration Test + Verification

**Files:**
- Create: `apps/api/src/settingsTest.ts`

- [ ] **Step 1: Write integration test**

Test that settings API endpoints work and runtime config changes take effect:

```typescript
// apps/api/src/settingsTest.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConfig } from './config.js';

describe('RuntimeConfig', () => {
  const original = { ...runtimeConfig.agent.toJSON() };

  after(() => {
    // Restore original values
    runtimeConfig.agent.maxConcurrent = original.maxConcurrent;
    runtimeConfig.agent.timeoutMs = original.timeoutMs;
    runtimeConfig.agent.queueTimeoutMs = original.queueTimeoutMs;
    runtimeConfig.agent.perSessionMax = original.perSessionMax;
  });

  it('should allow valid values', () => {
    runtimeConfig.agent.maxConcurrent = 5;
    assert.equal(runtimeConfig.agent.maxConcurrent, 5);
    assert.equal(config.agent.maxConcurrent, 5); // getter delegation works
  });

  it('should reject out-of-range values', () => {
    runtimeConfig.agent.maxConcurrent = 999;
    assert.equal(runtimeConfig.agent.maxConcurrent, 5); // unchanged
  });

  it('should round-trip through toJSON', () => {
    runtimeConfig.agent.maxConcurrent = 3;
    const json = runtimeConfig.agent.toJSON();
    assert.equal(json.maxConcurrent, 3);
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx tsx --test apps/api/src/settingsTest.ts
```

Expected: 3 tests pass.

- [ ] **Step 3: Verify all existing tests still pass**

```bash
npx tsx apps/api/src/concurrentAgentTest.ts
npx tsx --test apps/api/src/agent/core.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/settingsTest.ts
git commit -m "test: add RuntimeConfig integration tests"
```

---

## Summary

### Changed Files
| File | Action |
|------|--------|
| `apps/api/prisma/schema.prisma` | Add `UserSettings` model |
| `apps/api/src/config.ts` | Extract `RuntimeConfig` class |
| `apps/api/src/routes/settings.ts` | New: user + runtime settings API |
| `apps/api/src/routes/avatar.ts` | New: avatar upload API |
| `apps/api/src/index.ts` | Register routes, static serving |
| `apps/web/src/store/settingsStore.ts` | New: Zustand settings store |
| `apps/web/src/hooks/useSettings.ts` | New: settings fetch/save hook |
| `apps/web/src/components/AvatarUpload.tsx` | New: avatar upload component |
| `apps/web/src/components/RuntimeConfigForm.tsx` | New: admin config form |
| `apps/web/src/components/SettingsPanel.tsx` | New: settings side panel |
| `apps/web/src/components/NavBar.tsx` | Add settings gear button |

### Config Parameters (Admin-only, runtime hot-reloadable)
- `maxConcurrent` (default: 2, range: 1-20)
- `timeoutMs` (default: 300000, range: 10000-3600000)
- `queueTimeoutMs` (default: 120000, range: 10000-1800000)
- `perSessionMax` (default: 8, range: 1-50)

### User Settings (per-user)
- Avatar (file upload, max 2MB)
- Theme (dark/light)
- Notifications (on/off)
