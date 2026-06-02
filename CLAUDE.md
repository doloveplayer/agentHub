# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 快速了解项目结构

项目配置了 **CodeGraph MCP**（`codegraph_*` 工具），基于 tree-sitter 解析的知识图谱。
**优先使用 codegraph 而非 grep/read** 来理解代码结构：

| 问题 | 工具 |
|------|------|
| "X 在哪里定义？" | `codegraph_search` |
| "谁调用了 Y？" / "Y 调用了谁？" | `codegraph_callers` / `codegraph_callees` |
| "从 A 到 B 的调用链路？" | `codegraph_trace` |
| "改 Z 会影响什么？" | `codegraph_impact` |
| "给我 X 的源码/签名" | `codegraph_node` |
| "src/ 下有什么文件？" | `codegraph_files` |

详细用法见 `.claude/CLAUDE.md` 中的 CodeGraph 章节。

## Project overview

AgentHub is an IM-style web chat app that serves as a **smart collaboration hub** for multiple AI coding agents. Users log in via username/password, create sessions (solo or group), and interact with agents from multiple platforms (Claude Code, Codex, and user-registered agents) through a WebSocket-driven streaming interface. Each session gets an isolated Docker sandbox with a bind-mounted workspace.

### Core design philosophy

AgentHub is a **Smart Hub** — it actively coordinates, orchestrates, and manages multi-agent collaboration. It is NOT a passive message pipe.

What AgentHub owns as a platform:
- **Interaction experience**: conversation list, solo/group chat modes, deployment status cards, artifact preview/edit/re-interaction, message operations, context management
- **Main Agent coordination**: a Planner agent that understands user intent, decomposes complex tasks into DAG plans, and dispatches to sub-agents with dependency-aware scheduling
- **Multi-agent integration**: provider-agnostic agent layer (AbstractProvider + ProviderFactory). Supports Claude Code (SDK via docker exec). Codex provider 已有框架，待后续完成。 User-registered custom agents have persistent identity, skills, and memory across sessions
- **Artifact preview & editing**: inline preview of agent-produced artifacts — web pages, rendered documents, PPT browsing, code with diff view and version history. Users can quote document passages for incremental editing
- **Session & sandbox management**: Docker sandbox lifecycle per session (container `agenthub-sandbox-{sessionId}`), WebSocket multiplexing, message persistence, permission proxy
- **Task orchestration**: DAG-based task decomposition, in-process dispatch (ws/taskDispatcher.ts), parallel execution, dependency resolution, failure retry/replan

What AgentHub does NOT reimplement:
- Code generation, editing, file operations — those are the agent CLI/SDK tools' job
- Shell command execution, git operations — executed by agents inside sandboxes
- Language-specific analysis (linting, type-checking, vulnerability scanning) — delegated to agents

### Key directories

```
.agents/{agentId}/          — agent 持久化主目录（CLAUDE.md、memory、skills），跨 session 共享
.sandboxes/{sessionId}/     — 会话运行时（plan.json、agent 配置、inbox）
apps/api/src/               — 后端：Hono + Prisma + Dockerode + WebSocket
apps/web/src/               — 前端：React + Vite + Zustand + Tailwind
packages/shared/src/        — 前后端共享类型
docker/                     — sandbox 镜像 + sdk-runner
```

### Agent model

| 属性 | System agent | User agent |
|------|-------------|------------|
| 创建方式 | 群聊自动从 AgentTemplate 生成 | 用户手动创建或 solo 默认 |
| contextMode | `isolated` (per-session) | `shared` (跨 session) |
| 持久化 | `.agents/{agentId}/` (system agent 天然 session-scoped) | `.agents/{agentId}/` (跨所有 session 累计) |
| 典型 name | `code-agent-{sessionId[:8]}` | `code-agent` 或自定义 |

## Commands

```bash
# One-click startup (postgres, migrate, backend, frontend)
bash scripts/startup.sh          # logs → ./logs/

# One-click cleanup (stop servers, containers, sandboxes)
bash scripts/cleanup.sh

# Build sandbox image (after Dockerfile changes)
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .

# Manual TypeScript check
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# View latest logs (stored by timestamp: logs/YYYY-MM-DD_HH-MM-SS/)
tail -f logs/$(ls -t logs/ | head -1)/*.log

# Git push (HTTPS blocked by GFW — use SSH)
git remote set-url origin git@github.com:doloveplayer/agentHub.git
```

## Plan Management Workflow

计划和实现必须保持同步：

- **完成即更新**：每完成一个功能阶段（Phase/Tier/Task），必须同步更新 `docs/superpowers/plans/` 下对应 plan 文件的勾选状态（`- [ ]` → `- [x]`），不允许累积到多个阶段一起更新
- **分歧先讨论**：实施过程中发现 plan 的设计需要调整时，必须先与我讨论更优方案，而不是静默偏离 plan
- **改 Plan 再改 Code**：确认调整方向后，先修改 plan 文件使其反映新方案，再执行代码修改。杜绝 plan 和实际实现各说各话

## Multi-Agent Collaboration SOP

复杂需求的开发应该启用多 Agent 协作模型。Agent 定义在 `.claude/agents/` 目录下。每次开发遵循标准工作流：

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

## Debugging SOP

排查问题和 debug 时必须遵循：

1. **检查日志**：优先查看 `logs/` 目录下的 `backend.log`、`frontend.log`
2. **检查沙箱输出**：`.sandboxes/{sessionId}/` 下可能有 agent 的实际输出和错误日志
3. **检查 Agent 持久化目录**：`.agents/{agentId}/` 下有 agent 的 CLAUDE.md、memory、skills
4. **检查工作目录**：确认 session 绑定的 workspace 目录内容和版本追踪 `.agenthub/versions.json`
5. **检查 Docker 容器状态**：`docker inspect <container>` 验证挂载是否正确（`/workspace`, `/sandbox`, `/home/agents`）
6. **检查模型实际输出**：通过沙箱日志确认 Claude Code CLI 的真实 stdout/stderr
7. **复现问题**：复现测试消息触发实际流程，从日志和截图中定位错误
8. **复杂 bug**：启用 `/systematic-debugging` 技能进行系统化排查

## Code Writing Rule

**任何涉及编写代码的操作必须遵循 `/karpathy-guidelines`**：
- Think before coding — 先分析再动手
- Simplicity first — 最小代码解决问题，不过度抽象
- Surgical changes — 只改需要改的，不顺手重构
- Goal-driven — 定义可验证的成功标准

## Visual Testing

项目配置了可截图和图片理解的 MCP 服务，功能测试、debug和 UI 审查时应主动使用：

**浏览器自动化**（`document-skills:webapp-testing`）：
- 启动后端 `cd apps/api && npx tsx src/index.ts` + 前端 `cd apps/web && npx vite`
- 编写 Python Playwright 脚本截图、检查 DOM、验证交互

**图片分析 MCP**：
| 工具 | 用途 |
|------|------|
| `mcp__zai-mcp-server__analyze_image` | 通用图片理解：UI 布局评估、元素识别、异常检测 |
| `mcp__zai-mcp-server__ui_to_artifact` | UI 截图 → 代码/设计稿 |
| `mcp__zai-mcp-server__ui_diff_check` | 两张截图对比，找出视觉差异 |

**典型测试流程**：
1. `python3 script.py` 截取 3 个视口（390/768/1440）截图
2. `mcp__zai-mcp-server__analyze_image` 分析截图中的布局问题
3. 对照 plan 文件验证功能完整性
4. TypeScript 编译检查 `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json`

**中间结果保存**：
产生的中间截图调试应该保存至screenTmp/AgentScreenshots目录下，并调用图片分析 MCP进行分析

## E2E Testing with Auth Bypass

AgentHub uses username/password auth for all authenticated API calls. For automated E2E testing without real credentials, use the dev-token bypass endpoint:

### Setup

```bash
# Start backend with dev mode (NODE_ENV != production)
cd apps/api && NODE_ENV=development npx tsx src/index.ts
```

### Get a test token

```bash
curl http://localhost:3000/api/auth/dev-token | python3 -m json.tool
# → { "token": "eyJ...", "userId": "...", "login": "doloveplayer" }
```

### Use in Playwright tests

```python
import urllib.request, json

# 1. Get dev token
with urllib.request.urlopen("http://localhost:3000/api/auth/dev-token") as r:
    TOKEN = json.loads(r.read())["token"]

# 2. Inject into browser
await page.evaluate(f"""() => {{
    localStorage.setItem('agenthub_token', '{TOKEN}');
}}""")

# 3. Reload — now authenticated
await page.goto("http://localhost:5175", wait_until="networkidle")
```

### API calls

```bash
TOKEN=$(curl -s http://localhost:3000/api/auth/dev-token | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/auth/me
```

### Security

The dev-token endpoint is **disabled in production** (`NODE_ENV=production` returns 403). It returns a signed JWT for the default admin user without password verification.
