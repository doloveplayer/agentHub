# CLAUDE.md

此文件为 Claude Code 在本仓库中工作时提供指导。

## 项目概述

AgentHub 是一个 IM 风格的 Web 聊天应用，作为多个 AI 编程 agent 的**智能协作中枢**。用户通过用户名/密码登录，创建会话（单独或群聊），通过 WebSocket 驱动的流式接口与多平台 agent 交互。每个会话拥有一个独立的 Docker 沙箱容器，并挂载绑定的工作目录。

### 核心设计哲学

AgentHub 是一个**智能中枢**（Smart Hub）—— 主动协调、编排、管理多 agent 协作。它**不是**被动的消息管道。

AgentHub 作为平台负责：
- **交互体验**：会话列表、单独/群聊模式、部署状态卡片、产物预览/编辑/再交互、消息操作、上下文管理
- **主 Agent 协调**：Planner agent 理解用户意图，将复杂任务拆解为 DAG 计划，并分配到子 agent 执行，支持依赖感知调度
- **多 agent 接入**：provider 无关的 agent 层（AbstractProvider + ProviderFactory）。支持 Claude Code（通过 docker exec 运行 SDK）。Codex provider 已有框架，待后续完成。用户注册的自定义 agent 拥有跨 session 的持久化身份、技能和记忆
- **产物预览与编辑**：agent 产物的内联预览 —— 网页、渲染文档、PPT 浏览、带 diff 视图和版本历史的代码。用户可引用文档片段进行增量编辑
- **会话与沙箱管理**：每个 session 一个 Docker 沙箱（容器名 `agenthub-sandbox-{sessionId}`），WebSocket 多路复用，消息持久化，权限代理
- **任务编排**：基于 DAG 的任务拆解，进程内调度（`ws/taskDispatcher.ts`），并行执行，依赖解析，失败重试/重规划

AgentHub **不**重新实现：
- 代码生成、编辑、文件操作 —— 这些是 agent CLI/SDK 工具的工作
- Shell 命令执行、git 操作 —— 由 agent 在沙箱内执行
- 语言特定分析（linting、类型检查、漏洞扫描）—— 委托给 agent

### 关键目录

```
.agents/{agentId}/          — agent 持久化主目录（CLAUDE.md、memory、skills），跨 session 共享
.sandboxes/{sessionId}/     — 会话运行时（plan.json、agent 配置、inbox）
apps/api/src/               — 后端：Hono + Prisma + Dockerode + WebSocket
apps/web/src/               — 前端：React + Vite + Zustand + Tailwind
packages/shared/src/        — 前后端共享类型
docker/                     — 沙箱镜像 + sdk-runner
```

## 常用命令

```bash
# 一键启动（postgres, 数据库迁移, 后端, 前端）
bash scripts/startup.sh          # 日志 → ./logs/

# 一键清理（停止服务器、容器、沙箱）
bash scripts/cleanup.sh

# 构建沙箱镜像（Dockerfile 变更后）
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile docker/

# TypeScript 类型检查
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# 查看最新日志（按时间戳存储：logs/YYYY-MM-DD_HH-MM-SS/）
tail -f logs/$(ls -t logs/ | head -1)/*.log

# Git 推送（HTTPS 被墙 —— 使用 SSH）
git remote set-url origin git@github.com:doloveplayer/agentHub.git
```

## 计划管理工作流

计划和实现必须保持同步：

- **完成即更新**：每完成一个功能阶段，必须同步更新 `docs/superpowers/plans/` 下对应 plan 文件的勾选状态（`- [ ]` → `- [x]`），不允许累积到多个阶段一起更新
- **分歧先讨论**：实施过程中发现 plan 的设计需要调整时，必须先与我讨论更优方案，而不是静默偏离 plan
- **改 Plan 再改 Code**：确认调整方向后，先修改 plan 文件使其反映新方案，再执行代码修改。杜绝 plan 和实际实现各说各话

## 代码审查工作流

每完成一个功能板块，必须进行代码审查：

- 输入 `/code-review` 触发自动化代码审查
- 审查基于当前未提交的改动（或最近一次 commit）对比计划/需求文档
- 修复 Critical 和 Important 问题
- 不要跳过审查认为"改动简单没必要"

## 排错 SOP

排查问题和 debug 时必须遵循：

1. **检查日志**：优先查看 `logs/` 目录下的 `backend.log`、`frontend.log`
2. **检查沙箱输出**：`.sandboxes/{sessionId}/` 下可能有 agent 的实际输出和错误日志
3. **检查 Agent 持久化目录**：`.agents/{agentId}/` 下有 agent 的 CLAUDE.md、memory、skills
4. **检查工作目录**：确认 session 绑定的 workspace 目录内容和版本追踪 `.agenthub/versions.json`
5. **检查 Docker 容器状态**：`docker inspect <container>` 验证挂载是否正确（`/workspace`, `/sandbox`, `/home/agents`）
6. **检查模型实际输出**：通过沙箱日志确认 Claude Code 的真实 stdout/stderr
7. **复现问题**：复现测试消息触发实际流程，从日志和截图中定位错误
8. **复杂 bug**：启用 `/systematic-debugging` 技能进行系统化排查

## 代码编写规则

任何涉及编写代码的操作必须遵循 `/karpathy-guidelines`。

## 可视化测试

功能测试和 UI 审查应使用截图 + 图片分析 MCP（`analyze_image`、`ui_diff_check`）。

- 启动：`cd apps/api && npx tsx src/index.ts` + `cd apps/web && npx vite`
- 浏览器自动化：`document-skills:webapp-testing`（Playwright）
- 中间截图保存至 `screenTmp/AgentScreenshots/`
- TypeScript 编译检查：`npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json`

## E2E 测试（绕过认证）

自动化测试通过 dev-token 绕过密码认证：

```bash
# 启动（NODE_ENV != production）
cd apps/api && NODE_ENV=development npx tsx src/index.ts

# 获取 dev-token
curl http://localhost:3000/api/auth/dev-token
# → { "token": "eyJ...", "userId": "...", "login": "doloveplayer" }

# API 调用
TOKEN=$(curl -s http://localhost:3000/api/auth/dev-token | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents
```

- Playwright 中注入：`localStorage.setItem('agenthub_token', token)` 后刷新页面
- dev-token 仅在 `NODE_ENV=development` 下可用，生产环境返回 403
