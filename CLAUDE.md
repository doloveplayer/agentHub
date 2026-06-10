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
.agent-runtime/{agentId}/   — agent 持久化主目录（CLAUDE.md、memory、skills），跨 session 共享
.sandboxes/{sessionId}/     — 会话运行时（plan.json、agent 配置、inbox）
apps/api/src/               — 后端：Hono + Prisma + Dockerode + WebSocket
apps/web/src/               — 前端：React + Vite + Zustand + Tailwind
packages/shared/src/        — 前后端共享类型
docker/                     — 沙箱镜像 + sdk-runner
docs/adr/                   — 架构决策记录（ADR）
docs/changelog/             — 按月功能总结
docs/plans/                 — 活跃 plan
docs/architecture/          — 设计文档（specs）和测试报告（reports）
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

计划和实现必须保持同步。完成即更新、分歧先讨论、改 Plan 再改 Code。

→ 详细执行指南：使用 `/plan-management` skill

## 文档归档

文档按三层结构组织：ADR（架构决策）→ Changelog（按月功能总结）→ Plan（临时执行计划）。功能完成后归档 plan 到 changelog，架构决策写入 ADR。

→ 详细执行指南：使用 `/doc-archival` skill

## 文档编写规范

任何涉及飞书文档、技术架构文档、产品设计文档、ADR、Changelog 的编写或修改，必须遵循统一规范（Google / Apple / AWS / Stripe / Linear 标准提炼）。
文档编写先构思表达逻辑，搜索代码实现事实，再进行补充编写 

→ 详细执行指南：使用 `/doc-writing-standards` skill

## 代码审查工作流

每完成一个功能板块，必须进行代码审查。不要跳过。

→ 详细执行指南：使用 `/code-review-workflow` skill

## 排错 SOP

排查顺序：日志 → 沙箱输出 → Agent 目录 → 工作目录 → Docker 容器 → 模型输出 → 复现 → 系统化排查。不要跳步直奔修复。

→ 详细执行指南：使用 `/troubleshooting-sop` skill

## 代码编写规则

任何涉及编写代码的操作必须遵循 `/karpathy-guidelines`。

## 可视化测试

UI 功能通过截图 + 图像分析 MCP 验证，不要用纯文字描述替代视觉确认。

→ 详细执行指南：使用 `/visual-testing` skill

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
