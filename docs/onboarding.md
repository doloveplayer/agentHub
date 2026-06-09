# AgentHub 新人引导

> 目标：30 分钟内从零跑通项目，理解核心架构和开发流程。

## 前置条件

| 依赖 | 最低版本 | 检查命令 |
|------|---------|---------|
| Node.js | 20+ | `node --version` |
| Docker | 24+ | `docker --version` |
| Docker Compose | v2 | `docker compose version` |
| Git | 2.30+ | `git --version` |
| PostgreSQL | 15+（或用 Docker） | `psql --version` |

## 第一步：克隆与安装（5 分钟）

```bash
git clone git@github.com:doloveplayer/agentHub.git
cd agentHub
cp .env.example .env          # 编辑 .env 填入必要配置
npm install                    # 安装依赖
```

### .env 关键配置

```bash
# 必填
DATABASE_URL=postgresql://agenthub:agenthub@localhost:5432/agenthub
JWT_SECRET=your-secret-key
ADMIN_PASSWORD=your-admin-password

# Agent API Key（至少一个）
ANTHROPIC_API_KEY=sk-ant-...

# 可选
OPENCODE_API_KEY=...           # OpenCode Provider
REDIS_URL=redis://localhost:6379
```

## 第二步：一键启动（2 分钟）

```bash
bash scripts/startup.sh
```

启动流程：PostgreSQL → 数据库迁移 → 后端（:3000）→ 前端（:5175）

启动成功后访问 http://localhost:5175，使用 admin / {ADMIN_PASSWORD} 登录。

### 手动启动（调试用）

```bash
# 终端 1：后端
cd apps/api && npx tsx src/index.ts

# 终端 2：前端
cd apps/web && npx vite --host
```

## 第三步：理解项目结构

```
agentHub/
├── apps/
│   ├── api/src/               # 后端（Hono + Prisma + Dockerode + WebSocket）
│   │   ├── agent/             #   Agent 核心（Runtime、Provider、ContextBus）
│   │   ├── ws/                #   WebSocket 处理（chat、task、plan）
│   │   ├── routes/            #   REST API 路由
│   │   └── index.ts           #   入口
│   └── web/src/               # 前端（React + Vite + Zustand + Tailwind）
│       ├── components/        #   UI 组件
│       ├── store/             #   Zustand 状态管理
│       ├── lib/               #   工具函数
│       └── pages/             #   页面
├── packages/shared/src/       # 前后端共享类型
├── docker/                    # 沙箱镜像 + SDK Runner
├── docs/                      # 文档
│   ├── adr/                   #   架构决策记录
│   ├── architecture/          #   设计文档和测试报告
│   ├── changelog/             #   变更日志
│   └── onboarding.md          #   本文件
├── scripts/                   # 启动/清理脚本
├── prisma/                    # 数据库 Schema
└── CLAUDE.md                  # Claude Code 项目指令
```

## 第四步：理解核心数据流

### 用户消息 → Agent 响应

```
用户输入 → MessageInput.tsx
    → WebSocket → chatHandlers.ts
    → AgentRuntime.sendPrompt()
    → Provider.start() / sendPrompt()
    → Docker 容器内 Agent SDK 执行
    → EventParser 解析 stdout
    → UnifiedAgentEvent → WebSocket → 前端渲染
```

### 多 Agent 任务编排

```
用户需求 → Planner Agent
    → TaskPlan JSON → PlanValidator 校验
    → taskDispatcher 拓扑排序
    → 并行层分发到各 Agent REPL
    → AgentCoordinator 事件路由
    → 失败降级：自动重试 → ManagerLoop 重规划 → 人工介入
```

## 第五步：常用开发命令

```bash
# 类型检查
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# 构建沙箱镜像
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile docker/

# 查看日志
tail -f logs/$(ls -t logs/ | head -1)/*.log

# E2E 测试（绕过认证）
TOKEN=$(curl -s http://localhost:3000/api/auth/dev-token | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents

# 清理
bash scripts/cleanup.sh
```

## 第六步：理解关键模块

| 模块 | 文件 | 职责 |
|------|------|------|
| AgentRuntime | `agent/AgentRuntime.ts` | Agent 全局生命周期、队列、压缩 |
| AbstractProvider | `agent/providers/base.ts` | 多平台 Agent 统一接口 |
| SandboxManager | `agent/SandboxManager.ts` | Docker 沙箱创建和挂载 |
| taskDispatcher | `ws/taskDispatcher.ts` | DAG 任务调度和失败降级 |
| ContextBus | `agent/ContextBus.ts` | Agent 间共享上下文 |
| WorkspaceManager | `agent/WorkspaceManager.ts` | Git 快照和 Diff |
| InboxManager | `agent/InboxManager.ts` | Agent 间消息投递 |

## 第七步：了解设计决策

阅读 `docs/adr/` 下的 ADR 文件，理解关键技术选型：

| ADR | 一句话 |
|-----|--------|
| 001 | IM 聊天范式 + Docker 沙箱 |
| 002 | Smart Hub 协调层 + DAG 调度 |
| 003 | Agent 全局单例 + 常驻 REPL |
| 004 | AbstractProvider 多平台抽象 |
| 005 | ContextBus KV 黑板 + 自动压缩 |
| 006 | Planner 双重身份（主持人 + 规划器） |
| 007 | Provider capability 布尔值 |
| 008 | Git ref 快照 + ref-to-ref diff |
| 009 | 沙箱三分区挂载 |
| 010 | 三级失败降级 |
| 011 | 70% 阈值自动上下文压缩 |

## 常见问题

**Q: 后端启动报 "Missing required environment variable"**
A: 检查 `.env` 文件是否存在且包含必要变量。

**Q: Docker 容器创建失败**
A: 确保 Docker daemon 运行中，且当前用户有 Docker 权限（`sudo usermod -aG docker $USER`）。

**Q: 前端页面空白**
A: 检查后端是否在 :3000 端口运行，前端 WebSocket 连接依赖后端。

**Q: Agent 无响应**
A: 检查 `ANTHROPIC_API_KEY` 是否配置正确，查看后端日志中的 Agent 启动信息。

**Q: 沙箱镜像不存在**
A: 运行 `docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile docker/`
