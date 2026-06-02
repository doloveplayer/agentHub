# Agent System Prompt & Skills 自定义编辑

> 2026-06-02 | 支持前端编辑 Agent 的 system prompt 和 skills，全局生效

**Goal:** 用户可以在前端编辑 Agent 的 system prompt 和 skills（混合模式表单 + markdown 文件上传 + 严格校验），修改直接作用于 Agent 全局配置，所有引用该 Agent 的 session 同步生效。

**Architecture:** Agent 本身是全局实体（solo session 创建的 `type=user` agent 被 group session 添加时是同一个 agent），因此直接修改 `Agent` 表，不需要 session 级覆盖。废弃 `SessionAgent.systemPromptOverride`。

**Tech Stack:** Prisma/PostgreSQL, Zod, React + Zustand, Tailwind CSS

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/prisma/schema.prisma` | Modify | `Agent` 加 `skills` JSON 字段 |
| `apps/api/prisma/migrations/` | Auto | Prisma migration |
| `packages/shared/src/types.ts` | Modify | 加 `SkillDef`、`SkillsOverride` 接口，`AgentConfig` 加 `skills` |
| `apps/api/src/routes/agents.ts` | Modify | `PUT /:id` 扩展 `skills`，新增 `POST /skills/validate` |
| `apps/api/src/agent/AgentDirectoryManager.ts` | Modify | `initialize()` 根据 agent.skills 写入 skills 文件 |
| `apps/web/src/lib/api.ts` | Modify | `updateAgent` 扩展类型，新增 `validateSkillFile` |
| `apps/web/src/components/AgentConfigEditor.tsx` | **Rewrite** | 改为全局 agent config 编辑器，增加 skills 管理 |
| `apps/web/src/components/AgentCard.tsx` | Modify | `onConfigure` 不再依赖 session 级 API |
| `apps/web/src/pages/ChatPage.tsx` | (已修复) | 加 `useAuth()` 调用 |

---

## Task 1: DB — Agent 表加 skills 字段

**Files:**
- `apps/api/prisma/schema.prisma`

在 `Agent` model 中新增 `skills` 字段：

```prisma
model Agent {
  // ... 现有字段 ...
  skills        Json?           // 新增：skill 定义列表
}
```

`skills` 存储结构：
```typescript
// null 或 undefined = 无自定义 skills
// 非 null = 完全替换默认 skills
type AgentSkills = Array<{
  name: string;        // kebab-case, unique
  description: string; // 用于 UI 展示
  content: string;     // markdown body（不含 frontmatter）
}>
```

- [x] **Step 1: 修改 schema.prisma**
- [x] **Step 2: 运行 `npx prisma migrate dev` 生成 migration**

---

## Task 2: Shared Types 扩展

**Files:**
- `packages/shared/src/types.ts`

```typescript
// 新增接口
export interface SkillDef {
  name: string;
  description: string;
  content: string;
}

export interface SkillValidationResult {
  valid: boolean;
  skill?: SkillDef;
  errors?: Array<{ field: string; message: string }>;
}

// AgentConfig 扩展
export interface AgentConfig {
  // ... 现有字段 ...
  skills?: SkillDef[] | null;  // 新增
}
```

- [x] **Step 1: 在 types.ts 添加 `SkillDef`、`SkillValidationResult` 接口**
- [x] **Step 2: `AgentConfig` 添加 `skills` 字段**

---

## Task 3: Backend API — 扩展 Agent CRUD + 新增校验端点

**Files:**
- `apps/api/src/routes/agents.ts`

### 3.1 扩展 `PUT /api/agents/:id` 的 updateSchema

```typescript
const skillDefSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, 'name must be kebab-case'),
  description: z.string().min(1),
  content: z.string().min(1),
});

const updateSchema = z.object({
  // ... 现有字段 ...
  systemPrompt: z.string().min(1).optional(),
  skills: z.array(skillDefSchema).nullable().optional(),  // 新增
  // ...
});
```

### 3.2 新增 `POST /api/skills/validate`

接收 multipart/form-data 上传的 `.md` 文件，解析 frontmatter 并校验：

**校验规则（严格）：**
- frontmatter 格式正确（`---` 包裹的 YAML）
- `name` 必填、kebab-case
- `description` 必填
- content 非空（frontmatter 之后的部分）
- 文件大小 ≤ 100KB

**响应：**
```typescript
// 成功
{ valid: true, skill: { name, description, content } }
// 失败
{ valid: false, errors: [{ field: "name", message: "..." }] }
```

- [x] **Step 1: 定义 `skillDefSchema`**
- [x] **Step 2: 扩展 `updateSchema` 支持 `skills`**
- [x] **Step 3: PUT handler 中 `...parsed.data` 已自动包含 skills（Prisma Json 字段）**
- [x] **Step 4: 实现 `POST /skills/validate` 端点**
- [x] **Step 5: 扩展 `GET /:id` 返回 skills（如需要单独获取单个 agent 的端点）**

---

## Task 4: Runtime — Agent 启动时注入自定义 skills

**Files:**
- `apps/api/src/agent/AgentDirectoryManager.ts`

在 `initialize()` 方法中，从 agent 配置读取 `skills` 字段，将每个 skill 写入 `.claude/skills/{name}.md`：

```typescript
// initialize() 中新增（在写入 CLAUDE.md 之后）
// Inject user-defined skills
if (agentSkills && agentSkills.length > 0) {
  for (const skill of agentSkills) {
    const skillContent = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}`;
    writeFileSync(resolve(claudeConfigDir, 'skills', `${skill.name}.md`), skillContent, 'utf-8');
  }
}
```

Agent 的 `skills` 需要从 `Agent` 表读取后传入 `initialize()`。检查调用 `initialize()` 的地方（`ClaudeCodeProvider`、`AgentRuntime` 等）。

- [x] **Step 1: 修改 `initialize()` 签名，接收 `skills?: SkillDef[]` 参数**
- [x] **Step 2: 在 initialize 中写入 skills 文件**
- [x] **Step 3: 更新调用 initialize 的地方，传入 agent.skills**
- [x] **Step 4: `ensureAgentHome()` 也同步处理 skills**

---

## Task 5: Frontend API Client 扩展

**Files:**
- `apps/web/src/lib/api.ts`

```typescript
// 扩展 updateAgent 类型
updateAgent: (id: string, body: {
  displayName?: string; description?: string; systemPrompt?: string;
  skills?: SkillDef[] | null;  // 新增
}) => request<any>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

// 新增 skill 文件校验
validateSkillFile: (file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  return request<SkillValidationResult>('/skills/validate', {
    method: 'POST',
    body: formData,
    headers: {},  // 清除 Content-Type，让浏览器自动设置 multipart boundary
  });
},
```

- [x] **Step 1: 扩展 `updateAgent` 类型签名**
- [x] **Step 2: 新增 `validateSkillFile`**

---

## Task 6: Frontend — AgentConfigEditor 重构

**Files:**
- `apps/web/src/components/AgentConfigEditor.tsx` — **Rewrite**

### 6.1 架构变更

```
之前: AgentConfigEditor
  ├── Props: { sessionId, agentId }  ← 读 SessionAgent.systemPromptOverride
  ├── API: GET/PATCH /sessions/:id/agents/:agentId
  └── 功能: 仅 system prompt textarea

现在: AgentConfigEditor
  ├── Props: { agentId }           ← 直接读 Agent 全局配置
  ├── API: GET/PUT /agents/:id
  └── 功能: system prompt textarea + skills 管理
```

### 6.2 UI 结构

```
┌─────────────────────────────────────────────┐
│ Configure: code-agent-0025082e          [X] │
├─────────────────────────────────────────────┤
│                                             │
│ ▸ System Prompt                             │
│   ┌─────────────────────────────────────┐   │
│   │ (textarea, 可编辑)                   │   │
│   └─────────────────────────────────────┘   │
│                                             │
│ ▸ Skills                                    │
│   ┌─────────────────────────────────────┐   │
│   │ skill-1  [description...]   [✏️][🗑️] │   │
│   │ skill-2  [description...]   [✏️][🗑️] │   │
│   │                                     │   │
│   │ [+ Add Skill]  [📎 Upload .md]      │   │
│   └─────────────────────────────────────┘   │
│                                             │
│ ⚠️ 修改直接作用于 Agent 全局配置，            │
│    所有引用此 Agent 的 session 都会受到影响。 │
│                                             │
│                              [Cancel] [Save] │
└─────────────────────────────────────────────┘
```

### 6.3 交互流程

**手动添加 skill：**
1. 点击 "+ Add Skill" → 弹出 skill 编辑表单（name, description, content markdown editor）
2. 填写后点 "Add" → 本地 state 添加 → 点 Save 时统一提交

**上传 .md 文件：**
1. 点击 "📎 Upload .md" → 文件选择器
2. 选择文件 → 调用 `POST /api/skills/validate`
3. 校验通过 → 预览 skill 内容 → 用户确认 → 加入本地 state
4. 校验失败 → 显示具体错误信息

**编辑/删除：**
1. 点击 ✏️ → 编辑已有 skill
2. 点击 🗑️ → 确认后删除

### 6.4 替换风险提示

Skills 为完全替换模式，当用户首次添加自定义 skills 时显示警告：

> ⚠️ 自定义 skills 将**完全替换** Agent 的默认 skills。当前 Agent 没有默认 skills。
> （如果 Agent 已有默认 skills，则列出将被替换的 skills 名称）

- [x] **Step 1: 重构 Props（移除 sessionId，agentId 不变）**
- [x] **Step 2: 加载 agent 全局配置（`GET /api/agents` 或通过 store）**
- [x] **Step 3: 实现 skills 列表展示（name + description + edit/delete 按钮）**
- [x] **Step 4: 实现 skills 添加表单（name + description + content textarea）**
- [x] **Step 5: 实现 .md 文件上传 + 校验 + 预览流程**
- [x] **Step 6: 实现替换风险提示警告**
- [x] **Step 7: 保存时调用 `PUT /api/agents/:id`**

---

## Task 7: Frontend — 入口适配

**Files:**
- `apps/web/src/components/AgentCard.tsx`
- `apps/web/src/components/ChatView.tsx`

AgentCard 已经有 `onConfigure` 按钮（settings 图标），需要确保：
1. 传入的 `agentId` 是 agent 的全局 ID（已经是）
2. AgentConfigEditor 打开时传入正确的 agentId

如果 ChatView 中 `onConfigure` 回调的构建需要调整，同步修改。

- [x] **Step 1: 确认 AgentCard 的 `agentId` 是正确的全局 agentId**
- [x] **Step 2: 移除 ChatView 中 session 级 config 的加载逻辑（如有）**
- [x] **Step 3: 确认 solo session 中 AgentCard 也能打开配置**
- [x] **Step 4: 移除 `sessionAgentConfig` 相关 API 调用的引用（废弃）**

---

## Task 8: Cleanup — 废弃 SessionAgent.systemPromptOverride

**Files:**
- （不删除 DB 字段，仅标记废弃）
- `apps/api/src/routes/sessions.ts` — GET/PATCH `/:id/agents/:agentId` 保留但返回 deprecation 标记

保持向后兼容（不删除已有数据），但 Agent 启动逻辑不再读取 `systemPromptOverride`。

- [x] **Step 1: 在 Agent 初始化代码中移除对 `systemPromptOverride` 的读取**
- [x] **Step 2: 在 API 响应中标注字段为 deprecated（可选）**

---

## 验证 checklist

- [x] Solo session 的 agent 修改 system prompt 后，group session 中同一 agent 也能看到新 prompt
- [x] 上传 .md skill 文件，前端能正确显示校验错误
- [x] Skills 保存后，agent 重新启动时 skills 文件被正确写入 sandbox
- [x] 切换 session 后 agent 配置保持不变（全局生效）
- [x] Group session 默认的 system agent（type=system）不可被其他 session 添加（已有逻辑，无需改动）
- [x] TypeScript 编译通过
