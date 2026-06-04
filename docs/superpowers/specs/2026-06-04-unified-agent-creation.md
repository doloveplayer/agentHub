# AgentHub: 统一 Agent 创建流程 & 预设 Skills 库

> 2026-06-04 | Design Spec

## 目标

1. 统一 "Default Agent" 和 "Custom Agent" 为单一 "Create Agent" 弹窗
2. 现有 Agent 模板（code-agent, review-agent, devops-agent, test-agent）作为可选模板
3. 预设 34 个可勾选 skills，从 `~/.claude` 插件体系导入
4. Group session 的 Add 面板也支持直接创建新 Agent
5. 创建的 Agent 统一为全局配置（有独立 sandbox、可跨 session 复用）

## 数据流

```
CreateAgentModal 提交
  → api.createAgent({ name, displayName, description, systemPrompt, skills })
  → 后端 POST /api/agents 独立创建 Agent 端点
  → Solo: createSession({ type:'solo', agentIds:[newAgentId] })
  → Group: addSessionAgents(sessionId, [newAgentId])
  → 刷新 agents/sessions store
```

## UI 设计

### CreateAgentModal（新建组件）

```
┌───────────────────────────────────────────────┐
│  Create Agent                              ✕  │
├───────────────────────────────────────────────┤
│                                               │
│  Template                                     │
│  ┌──────┬──────┬──────┬──────┬────────┐       │
│  │ Code │Review│DevOps│ Test │ Custom │       │
│  │Agent │Agent │Agent │Agent │ (blank)│       │
│  └──────┴──────┴──────┴──────┴────────┘       │
│                                               │
│  Display Name *                               │
│  Description *                                │
│  System Prompt * (template 选择后自动填充)     │
│                                               │
│  Skills  (collapsible groups)                 │
│  ┌───────────────────────────────────────┐    │
│  │ Search: [                    ]        │    │
│  │                                       │    │
│  │ ▶ Quality (6)                        │    │
│  │ ▼ Workflow (7)                       │    │
│  │   ☑ brainstorming                    │    │
│  │   ☐ writing-plans                    │    │
│  │   ...                                │    │
│  │ ▶ Creative (6)                       │    │
│  │ ▶ Documents (13)                     │    │
│  │                                       │    │
│  │ [+ Custom Skill]  [📤 Upload .md]    │    │
│  └───────────────────────────────────────┘    │
│                                               │
├───────────────────────────────────────────────┤
│                        [Cancel]  [Create]     │
└───────────────────────────────────────────────┘
```

### 模板选择

| 模板 | 显示名 | 描述 | 默认 Skills |
|------|--------|------|-------------|
| CodeAgent | CodeAgent | Writes and modifies code, runs shell commands, creates files | karpathy-guidelines |
| ReviewAgent | ReviewAgent | Reviews code for bugs, security vulnerabilities, and style issues | karpathy-guidelines |
| DevOpsAgent | DevOpsAgent | Handles deployment, CI/CD, Docker, and infrastructure tasks | — |
| TestAgent | TestAgent | Generates tests, runs test suites, and reports results | — |
| Custom | — | Start from scratch | — |

### 上下文相关行为

| 入口 | 会话类型 | 创建后的操作 |
|------|---------|------------|
| Solo Session 创建菜单 | — | `POST /agents` → `POST /sessions { type:'solo', agentIds:[id] }` → 激活 session |
| Group Session Add 面板 | group | `POST /agents` → `POST /sessions/:id/agents { agentIds:[id] }` → 加入群聊 |

## 后端改动

### 新增 `POST /api/agents`

```typescript
const createSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  displayName: z.string().min(1).max(64),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1).max(8000),
  skills: z.array(skillDefSchema).optional(),
});
```

### 新增 `GET /api/agents/preset-skills`

返回 preset skills 列表（name + description，不含 content）。

### 预设 Skills 种子数据

`apps/api/src/presetSkills.ts` — 34 个 SkillDef，content 从 `~/.claude/skills/` 和 `~/.claude/plugins/` 中的 SKILL.md 文件提取。

## Skills 预设清单（34 个）

### Quality（6）
karpathy-guidelines, systematic-debugging, test-driven-development, verification-before-completion, requesting-code-review, receiving-code-review

### Workflow（8）
brainstorming, writing-plans, writing-skills, executing-plans, subagent-driven-development, dispatching-parallel-agents, finishing-a-development-branch, using-git-worktrees

### Creative（6）
frontend-design, canvas-design, algorithmic-art, theme-factory, web-artifacts-builder, slack-gif-creator

### Documents（14）
docx, xlsx, pptx, pdf, pdf-generator, doc-coauthoring, internal-comms, claude-api, mcp-builder, webapp-testing, brand-guidelines, skill-creator, cc-nano-banana, archive-experience

## 前端改动

| 文件 | 操作 |
|------|------|
| **新建** `CreateAgentModal.tsx` | 统一创建弹窗 |
| `SessionList.tsx` | 删除双按钮 + customAgentMode |
| `AddAgentModal.tsx` | 顶部增加 "Create New Agent" |
| `lib/api.ts` | 新增 `createAgent()`, `getPresetSkills()` |

## 验证计划

1. `GET /api/agents/preset-skills` 返回 34 个 skills
2. `POST /api/agents` 创建 agent，preset skill 名自动解析为完整 content
3. CreateAgentModal: 选模板→自动填充，勾选 skills→保存后回显
4. Solo 创建 → agent 正常工作
5. Group 创建 → 新 agent 加入群聊并可用
