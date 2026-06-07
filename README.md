# AgentHub

智能多 Agent 协作中枢 — IM 风格的 Web 聊天应用，作为多个 AI 编程 Agent 的统一管理和调度平台。

## 项目简介

AgentHub 让你在类似聊天软件的界面中，同时驱动多个 AI Agent 协作完成开发任务。每个会话拥有独立的 Docker 沙箱环境，支持 Solo（单 Agent）和 Group（多 Agent 协作）两种模式。

**核心能力：**
- 多 Agent 协作 — Planner 自动拆解任务、分配给 CodeAgent / ReviewAgent / TestAgent 等执行
- Docker 沙箱隔离 — 每个会话独立容器，安全互不干扰
- 流式对话 — 实时查看 Agent 的工具调用、文件修改、输出过程
- 产物预览 — 内置静态服务器，直接在浏览器中预览 Agent 生成的网页
- 任务编排 — DAG 依赖调度、并行/串行执行、失败重试

## 快速开始

### 环境要求

- Node.js 20+
- Docker
- PostgreSQL 16+

### 安装

```bash
# 克隆仓库
git clone https://github.com/doloveplayer/agentHub.git
cd agentHub

# 安装依赖
npm install

# 构建沙箱镜像
docker build -t agenthub-sandbox:latest -f docker/sandbox.Dockerfile .
```

### 配置

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env，填入你的配置
```

`.env` 中必须配置：

```bash
# 数据库连接（应用层必配）
DATABASE_URL=postgresql://agenthub:your_secure_password@localhost:5432/agenthub

# JWT 密钥（用于会话认证，务必使用随机字符串）
JWT_SECRET=your_random_secret_string

# 管理员密码（必配，无默认值）
ADMIN_PASSWORD=your_secure_password
```

可选配置（有合理默认值）：

```bash
# 数据库凭据（docker-compose 使用，本地开发可保持默认）
POSTGRES_USER=agenthub
POSTGRES_PASSWORD=your_secure_password

# 管理员用户名（默认 admin）
ADMIN_USERNAME=admin

# AI Provider（至少配置一个 token）
ANTHROPIC_AUTH_TOKEN=your_anthropic_api_key

# 其他可选
PORT=3000
REDIS_URL=redis://localhost:6379
HTTPS_PROXY=
```

### 启动

```bash
# 一键启动（PostgreSQL + 数据库迁移 + 后端 + 前端）
bash scripts/startup.sh
```

打开 `http://localhost:5175`，使用管理员账号登录。

### 手动启动

```bash
# 启动数据库
docker compose up -d postgres redis

# 数据库迁移
cd apps/api && npx prisma migrate dev --name init

# 后端（端口 3000）
cd apps/api && npx tsx src/index.ts

# 前端（端口 5175）
cd apps/web && npx vite
```

## 使用方式

1. **创建 Agent** — 点击侧边栏 "+" 按钮，选择模板创建 Agent（CodeAgent、ReviewAgent 等）
2. **Solo 会话** — 点击 Agent 名称，进入一对一对话
3. **Group 会话** — 创建群聊，添加多个 Agent，用 `@AgentName` 指定任务对象
4. **任务规划** — 在群聊中描述需求，Planner 会自动拆解为 DAG 任务并分配执行
5. **产物预览** — Agent 生成的网页文件可直接在内置浏览器中预览

## 技术栈

| 层级 | 技术 | 职责 |
|------|------|------|
| 前端 | React 18 + Vite + Tailwind + Zustand | 聊天 UI、流式渲染、状态管理 |
| 后端 | Hono + Prisma + WebSocket | REST API、实时通信、沙箱管理 |
| 沙箱 | Docker + Dockerode | 容器隔离、文件挂载、进程管理 |
| 共享 | TypeScript | 前后端共享类型定义 |

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。

## 贡献

欢迎提交 Issue 和 Pull Request！

- **Bug 报告** — 请通过 [Issues](https://github.com/doloveplayer/agentHub/issues) 提交，附上复现步骤和日志
- **功能建议** — 在 Issues 中描述你的想法和使用场景
- **代码改进** — Fork 本仓库，创建分支，提交 PR

我们乐意接受任何形式的反馈和改进意见。
