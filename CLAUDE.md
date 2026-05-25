# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

AgentHub is an IM-style web chat app that serves as a **smart collaboration hub** for multiple AI coding agents. Users log in via GitHub OAuth, create sessions (solo or group), and interact with agents from multiple platforms (Claude Code, Codex, OpenCode, and user-registered agents) through a WebSocket-driven streaming interface. Each session gets an isolated Docker sandbox with a bind-mounted workspace at `.sandboxes/{sessionId}/`.

### Core design philosophy

AgentHub is a **Smart Hub** — it actively coordinates, orchestrates, and manages multi-agent collaboration. It is NOT a passive message pipe.

What AgentHub owns as a platform:
- **Interaction experience**: conversation list, solo/group chat modes, deployment status cards, artifact preview/edit/re-interaction, message operations, context management
- **Main Agent coordination**: a PM/PMO-style orchestrator that understands user intent, decomposes complex tasks, dispatches to sub-agents, handles parallel scheduling, failure degradation, and code conflict resolution
- **Multi-agent integration**: provider-agnostic agent接入层, supports at least Claude Code + one other mainstream platform (Codex/OpenCode), plus user-registered custom agents. Each agent has avatar, display name, and capability tags in the chat interface
- **Artifact preview & editing**: inline preview and editing of agent-produced artifacts — web pages, rendered documents, PPT browsing, code with diff view and version history. Users can quote document passages and hand them to agents for further processing
- **Session & sandbox management**: Docker sandbox lifecycle, WebSocket multiplexing, message persistence, permission proxy
- **Task orchestration**: DAG-based task decomposition, BullMQ scheduling, parallel execution, failure retry/downgrade, result aggregation

What AgentHub does NOT reimplement:
- Code generation, editing, file operations — those are the agent CLI tools' job
- Shell command execution, git operations — executed by agents inside sandboxes
- Language-specific analysis (linting, type-checking, vulnerability scanning) — delegated to agents

In short: AgentHub is a **smart hub with a chat UI**. The intelligence is distributed — coordination lives in the hub, execution lives in the agents.

## Code navigation

When you need to understand or query the codebase (find where something is defined, trace relationships between files, identify which layer a component belongs to), **first consult the knowledge graph** at `.understand-anything/knowledge-graph.json`. The graph contains:

- **Nodes**: 119 files across 9 architectural layers (Frontend, Backend API, Agent Engine, WebSocket, Backend Infra, Shared Types, Docker, Docs, Config)
- **Edges**: import and dependency relationships between files
- **Layers**: which layer each file belongs to
- **Tour**: 7-step guided walkthrough of the architecture

Use it to answer questions like "what files import X?", "which layer does Y belong to?", or "what's the dependency chain from A to B?" before falling back to grep/find. This reduces token consumption and speeds up lookups.

## Commands

```bash
# Start PostgreSQL
docker compose up -d postgres

# Build sandbox image (after Dockerfile changes)
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .

# Prisma migrate (project root — .env must export DATABASE_URL)
export $(grep -v '^#' .env | grep -v '^$' | xargs) && cd apps/api && npx prisma migrate dev --name init

# Backend (port 3000)
cd apps/api && npx tsx src/index.ts

# Frontend (port 5173, proxies /api and /ws to backend)
cd apps/web && npx vite

# TypeScript check
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# Force stop
fuser -k 3000/tcp  # backend
fuser -k 5173/tcp  # frontend

# Cleanup orphaned sandboxes
docker rm -f $(docker ps -aq --filter name=agenthub-sandbox) 2>/dev/null
rm -rf .sandboxes/*

# Git push (HTTPS blocked by GFW — use SSH)
git remote set-url origin git@github.com:doloveplayer/agentHub.git
```

## Plan Management Workflow

计划和实现必须保持同步：

- **完成即更新**：每完成一个功能阶段（Phase/Tier/Task），必须同步更新 `docs/superpowers/plans/` 下对应 plan 文件的勾选状态（`- [ ]` → `- [x]`），不允许累积到多个阶段一起更新
- **分歧先讨论**：实施过程中发现 plan 的设计需要调整时，必须先与我讨论更优方案，而不是静默偏离 plan
- **改 Plan 再改 Code**：确认调整方向后，先修改 plan 文件使其反映新方案，再执行代码修改。杜绝 plan 和实际实现各说各话

## Multi-Agent Collaboration SOP

Phase 3+ 开发启用多 Agent 协作模型。Agent 定义在 `.claude/agents/` 目录下。每次开发遵循标准工作流：

**SOP 四步流程：**

1. **[@Main Agent]** — 用户提出功能需求 → 由 Main Agent 输出 DAG 任务拆解 + 接口契约（REST/WS/data model）
   - 文件：`.claude/agents/Main_Agent.md`
2. **确认** — 用户审核 DAG 和契约，确认无误后进入实现阶段
3. **[@Backend / @Frontend]** — 按任务依赖顺序，每次聚焦一个独立节点，完成单文件或单模块闭环
   - 文件：`.claude/agents/Backend_Agent.md`, `.claude/agents/Frontend_Agent.md`
4. **[@Review]** — 模块写完后，自发进行代码审查：类型安全、架构一致性、资源回收、安全边界
   - 文件：`.claude/agents/Review_Agent.md`

**Agent 调度原则：**
- Main Agent 输出 DAG 后自动退出，不参与具体实现
- Backend/Frontend 只实现自己职责范围的代码，不跨界
- Review Agent 发现的问题反馈给对应 Agent 修复，不直接修改代码
- 每个 Agent 完成任务后更新对应 plan 文件的 checkboxes

## Code Review Workflow

每完成一个功能板块，必须进行代码审查：

- 输入 `/code-review` 触发自动化代码审查（调用 `superpowers:requesting-code-review` 技能）
- 审查基于当前未提交的改动（或最近一次 commit）对比计划/需求文档
- 修复 Critical 和 Important 问题
- 不要跳过审查认为"改动简单没必要"

## Visual Testing

项目配置了可截图和图片理解的 MCP 服务，功能测试和 UI 审查时应主动使用：

**浏览器自动化**（`document-skills:webapp-testing`）：
- 启动后端 `cd apps/api && npx tsx src/index.ts` + 前端 `cd apps/web && npx vite`
- 编写 Python Playwright 脚本截图、检查 DOM、验证交互
- 模板见 `/tmp/agentHub_e2e_test.py` 等历史脚本

**图片分析 MCP**：
| 工具 | 用途 |
|------|------|
| `mcp__zai-mcp-server__analyze_image` | 通用图片理解：UI 布局评估、元素识别、异常检测 |
| `mcp__zai-mcp-server__ui_to_artifact` | UI 截图 → 代码/设计稿（`output_type: 'code'\|'spec'\|'description'`） |
| `mcp__zai-mcp-server__ui_diff_check` | 两张截图对比，找出视觉差异 |

**典型测试流程**：
1. `python3 script.py` 截取 3 个视口（390/768/1440）截图
2. `mcp__zai-mcp-server__analyze_image` 分析截图中的布局问题
3. 对照 plan 文件验证功能完整性
4. TypeScript 编译检查 `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json`