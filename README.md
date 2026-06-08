<h1 align="center">AgentHub</h1>
<p align="center">
  <strong>智能多 Agent 协作中枢 — IM 风格的 Web 聊天应用，作为多个 AI 编程 Agent 的统一管理和调度平台</strong>
  <br />
  <em>支持 Claude Code、OpenCode 等多种 Agent Provider，DAG 任务编排，Docker 沙箱隔离。</em>
</p>

<p align="center">
  <a href="https://htmlpreview.github.io/?https://github.com/doloveplayer/agentHub/blob/feature/agent-output-editor/index.html"><img src="https://img.shields.io/badge/项目介绍页-HTML-0ea5a5?style=flat-square" alt="Project Page" /></a>
  <a href="https://github.com/doloveplayer/agentHub/blob/master/LICENSE"><img src="https://img.shields.io/badge/许可证-MIT-yellow?style=flat-square" alt="License: MIT" /></a>
  <a href="https://github.com/doloveplayer/agentHub"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://github.com/doloveplayer/agentHub"><img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React" /></a>
  <a href="https://github.com/doloveplayer/agentHub"><img src="https://img.shields.io/badge/Hono-4.6-ff6b35?style=flat-square" alt="Hono" /></a>
  <a href="https://github.com/doloveplayer/agentHub"><img src="https://img.shields.io/badge/Prisma-5.22-2D3748?style=flat-square&logo=prisma&logoColor=white" alt="Prisma" /></a>
  <a href="https://github.com/doloveplayer/agentHub"><img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" /></a>
  <a href="https://github.com/doloveplayer/agentHub"><img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" /></a>
  <a href="https://github.com/doloveplayer/agentHub"><img src="https://img.shields.io/badge/WebSocket-ws-000?style=flat-square" alt="WebSocket" /></a>
</p>

<br />

> **AgentHub 不是又一个 Chat UI。** 它是 **Smart Hub** — 主动协调、编排、管理多个 AI Agent 的协作平台。就像 Git 让开发者协作写代码，AgentHub 让 AI Agent 协作完成任务。

---

## 项目简介

AgentHub 让你在类似聊天软件的界面中，同时驱动多个 AI Agent 协作完成开发任务。每个会话拥有独立的 Docker 沙箱环境，支持 Solo（单 Agent）和 Group（多 Agent 协作）两种模式。

> [!NOTE]
> **想了解完整架构？** 查看 [📄 项目介绍页（交互式 HTML）](https://htmlpreview.github.io/?https://github.com/doloveplayer/agentHub/blob/feature/agent-output-editor/index.html) — 深色/浅色主题切换，架构/功能/技术栈全览。

**核心能力：**

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🤝 多 Agent 协作</h3>
      <p>Planner 自动拆解任务、分配给 CodeAgent / ReviewAgent / TestAgent 等执行。每个 Agent 拥有独立的持久化身份、技能和记忆。</p>
    </td>
    <td width="50%" valign="top">
      <h3>🐳 Docker 沙箱隔离</h3>
      <p>每个会话独立容器，三层挂载体系（运行时 / 工作区 / Agent 持久化身份），安全互不干扰。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>⚡ 流式对话</h3>
      <p>实时查看 Agent 的工具调用、文件修改、输出过程。15 种 WebSocket 事件类型，毫秒级延迟推送。</p>
    </td>
    <td width="50%" valign="top">
      <h3>🎨 产物预览</h3>
      <p>内置静态服务器，直接在浏览器中预览 Agent 生成的网页、PPT、代码 Diff。支持引用编辑和版本历史。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📊 任务编排</h3>
      <p>DAG 依赖调度、并行/串行执行、三级失败恢复（自动重试 → ManagerLoop 审查 → Planner 升级）。</p>
    </td>
    <td width="50%" valign="top">
      <h3>🧠 ContextBus 共享记忆</h3>
      <p>结构化键值存储，优先级衰减算法，上下文预算裁剪，Pinned 消息强制注入。跨 Agent 共享项目发现和架构决策。</p>
    </td>
  </tr>
</table>

---

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

---

## 使用方式

1. **创建 Agent** — 点击侧边栏 "+" 按钮，选择模板创建 Agent（CodeAgent、ReviewAgent 等）
2. **Solo 会话** — 点击 Agent 名称，进入一对一对话
3. **Group 会话** — 创建群聊，添加多个 Agent，用 `@AgentName` 指定任务对象
4. **任务规划** — 在群聊中描述需求，Planner 会自动拆解为 DAG 任务并分配执行
5. **产物预览** — Agent 生成的网页文件可直接在内置浏览器中预览

---

## 技术栈

| 层级 | 技术 | 职责 |
|------|------|------|
| 前端 | React 18 + Vite + Tailwind + Zustand | 聊天 UI、流式渲染、状态管理 |
| 后端 | Hono + Prisma + WebSocket | REST API、实时通信、沙箱管理 |
| 沙箱 | Docker + Dockerode | 容器隔离、文件挂载、进程管理 |
| 共享 | TypeScript | 前后端共享类型定义 |

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。

---

## 贡献

欢迎提交 Issue 和 Pull Request！

- **Bug 报告** — 请通过 [Issues](https://github.com/doloveplayer/agentHub/issues) 提交，附上复现步骤和日志
- **功能建议** — 在 Issues 中描述你的想法和使用场景
- **代码改进** — Fork 本仓库，创建分支，提交 PR

我们乐意接受任何形式的反馈和改进意见。
