# Solo Session 按 Agent 分组展示 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 SessionList 改为 Solo 按 Agent 分组、Group 单独分组的视图，支持 Agent 的 inline 管理（删除、重命名、编辑）。

**Architecture:** 纯前端改动。后端 GET /sessions 返回的数据结构不变，前端按 session.agents[0].agentId 对 solo session 分组。Agent 管理复用已有的 PUT/DELETE /agents API。

**Tech Stack:** React + Zustand + Tailwind（仅改 SessionList.tsx）

---

## Task 1: 重构 SessionList — Solo 按 Agent 分组 + Group 独立分组

**Files:**
- Modify: `apps/web/src/components/SessionList.tsx`

- [ ] **Step 1: 实现分组逻辑**

在 `SessionList` 组件内，将 sessions 按类型分组：

```typescript
// 在 loadSessions 之后，computed 分组数据
const { soloByAgent, groupSessions } = useMemo(() => {
  const soloByAgent = new Map<string, { agent: { id: string; name: string; displayName: string }; sessions: any[] }>();
  const groupSessions: any[] = [];

  for (const s of sessions) {
    if (s.type === 'group') {
      groupSessions.push(s);
      continue;
    }
    // Solo: group by first agent
    const agentInfo = s.agents?.[0];
    const agentId = agentInfo?.agentId || 'unknown';
    if (!soloByAgent.has(agentId)) {
      soloByAgent.set(agentId, {
        agent: agentInfo || { id: agentId, name: 'unknown', displayName: 'Unknown Agent' },
        sessions: [],
      });
    }
    soloByAgent.get(agentId)!.sessions.push(s);
  }

  return { soloByAgent, groupSessions };
}, [sessions]);
```

- [ ] **Step 2: 实现 Agent 折叠栏 + Session 列表**

替换现有的 session 列表渲染，改为两个折叠栏：Solo（按 agent 分组）和 Group。

每个 agent 行显示：
- 折叠/展开箭头
- Agent displayName
- Session 数量 badge
- 操作按钮（编辑、删除）— hover 时显示

每个 session 行保持现有样式：标题、最后消息预览、删除按钮、未读计数。

- [ ] **Step 3: TypeScript 编译检查**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

---

## Task 2: Agent Inline 管理 — 重命名、编辑描述、编辑 systemPrompt

**Files:**
- Modify: `apps/web/src/components/SessionList.tsx`

- [ ] **Step 1: Agent 行 inline 编辑**

点击 agent 行的编辑按钮 → agent 行变为编辑模式：
- displayName: inline input
- description: inline input
- systemPrompt: inline textarea（或弹出小 modal，因为 prompt 很长）
- 保存 → 调用 `api.updateAgent(agentId, { displayName, description, systemPrompt })`
- 取消 → 恢复显示模式

- [ ] **Step 2: 添加 updateAgent 到 API client**

在 `apps/web/src/lib/api.ts` 中已有 `PUT /agents/:id`，但需要确认 API client 是否有对应方法。如果没有，添加：

```typescript
updateAgent: (id: string, body: { displayName?: string; description?: string; systemPrompt?: string }) =>
  request<any>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
```

- [ ] **Step 3: TypeScript 编译检查**

---

## Task 3: Agent 删除 — 级联删除 solo sessions + 从 group 移除

**Files:**
- Modify: `apps/web/src/components/SessionList.tsx`
- Modify: `apps/web/src/store/appStore.ts`（如需要）

- [ ] **Step 1: Agent 删除确认弹窗**

点击 agent 行的删除按钮 → 弹出确认弹窗：
- 显示 agent 名称
- 警告："将删除该 agent 的所有 N 个 solo session，并从所有 group 中移除"
- 确认 → 调用 `api.deleteAgent(agentId)`
- 后端已有级联逻辑（软删除 agent + 删除 SessionAgent + 广播 agent_removed）
- 前端需要：从 sessions store 中移除该 agent 的所有 solo session

- [ ] **Step 2: 添加 deleteAgent 到 API client**

确认 `api.ts` 是否有 `deleteAgent`。如果没有：

```typescript
deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
```

- [ ] **Step 3: 前端状态同步**

删除 agent 后：
1. 从 `sessions` store 中过滤掉该 agent 的所有 solo session
2. 从 `agents` store 中移除该 agent
3. 如果当前 activeSession 被删除，切换到最近的 session

---

## Task 4: 修复 Create Session 弹框位置 bug

**Files:**
- Modify: `apps/web/src/components/SessionList.tsx`

- [ ] **Step 1: 修复 `+` 弹框定位**

当前弹框用 `absolute top-full right-0`，在左侧 sidebar 中会导致向左溢出被裁剪。改为向右展开：

```tsx
<div className="absolute top-full left-0 mt-1 ...">
```

或用 `right-auto left-0` 确保弹框从按钮右侧展开。

- [ ] **Step 2: 视觉验证**

---

## Task 5: TypeScript 编译 + 功能验证

- [ ] **Step 1: 全量 TypeScript 检查**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 2: 视觉验证**

启动前后端，截图验证 SessionList 的分组显示效果。
