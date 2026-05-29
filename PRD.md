# AgentHub 产品需求文档 (PRD)

> **版本**：v0.5.0
> **状态**：Phase 1/2 完成，Phase 3 核心能力完成，统一 REPL 架构落地，Phase 5 设置页面规划中
> **拟定人**：AgentHub 项目团队
> **日期**：2026-05-19 · 修订 2026-05-28（多 Agent 并发修复 + Phase 5 用户设置与运行时配置）

---

## 目录

1. [项目背景与愿景](#1-项目背景与愿景)
2. [核心目标与成功指标](#2-核心目标与成功指标)
3. [用户画像与典型场景](#3-用户画像与典型场景)
4. [功能需求 (分阶段)](#4-功能需求)
   - [阶段 1：MVP — 单 Agent 聊天 + 沙箱](#41-阶段-1mvp--单-agent-聊天--沙箱)
   - [阶段 2：多 Agent 群聊与 @ 指令](#42-阶段-2多-agent-群聊与--指令)
   - [阶段 3：Smart Hub 核心能力](#43-阶段-3smart-hub-核心能力)
   - [阶段 4：产物预览与部署闭环](#44-阶段-4产物预览与部署闭环)
   - [阶段 5：用户设置与运行时配置](#45-阶段-5用户设置与运行时配置)
5. [技术栈详细说明](#5-技术栈详细说明)
6. [系统架构概要](#6-系统架构概要)
7. [多平台 Agent 接入层设计](#7-多平台-agent-接入层设计)
8. [Main Agent 协调器设计](#8-main-agent-协调器设计)
9. [产物预览与编辑系统](#9-产物预览与编辑系统)
10. [权限代理机制](#10-权限代理机制)
11. [开发路线图与迭代计划](#11-开发路线图与迭代计划)
12. [非功能性需求](#12-非功能性需求)
13. [风险与应对](#13-风险与应对)

---

## 1. 项目背景与愿景

AI Agent 工具（Claude Code、Codex、OpenCode 等）已具备强大的代码生成和任务执行能力，但现有交互方式局限在终端或 IDE 插件中，缺乏**多平台 Agent 统一接入、多人/多 Agent 会话式协作、产物可视化预览、以及从需求到部署的一站式体验**。

AgentHub 的愿景是：**打造一个 IM 聊天式的多平台 AI Agent 协作中枢（Smart Hub）**——一个 Web 聊天界面，统一管理和编排来自不同平台的多个 AI Agent，让用户通过自然语言驱动多 Agent 协同完成从需求分析、编码实现、产物预览到部署上线的全流程开发工作。

### 核心设计哲学：Smart Hub

AgentHub 是一个**智能协作中枢**，主动承担协调、编排和管理的职责。智能分布在两层：**协调层在 Hub，执行层在 Agent**。

| AgentHub 负责（Smart Hub 层） | 交给 Agent 执行（Agent 层） |
|---|---|
| IM 聊天界面（会话列表、单聊/群聊、消息气泡、@ 面板、/ 面板） | 代码生成、编辑、文件操作 |
| Main Agent 协调（PM/PMO 角色，需求理解、任务拆解、DAG 编排） | Shell 命令执行、Git 操作 |
| 多平台 Agent 接入与路由（Claude Code、Codex、OpenCode、自建 Agent） | 代码审查、测试生成 |
| 会话/消息持久化（PostgreSQL）、上下文管理 | 依赖分析、漏洞扫描 |
| 沙箱容器管理（创建/销毁/挂载）、文件系统隔离 | 语言特定工具链操作 |
| 产物预览与编辑（网页、文档、PPT、代码 Diff 视图、版本历史） | |
| 部署编排（构建 → 推送 → 部署，状态卡片推送） | |
| DAG 任务可视化、进度追踪、失败降级、代码冲突检测 | |
| WebSocket 实时推送、权限代理 | |
| Agent 状态监控（运行状态、上下文用量、当前工具、子 Agent） | |

**关键边界**：AgentHub 不重新实现 Agent CLI 已有的代码生成/编辑/执行能力，而是专注做好**协调 + 体验 + 编排**三层。

---

## 2. 核心目标与成功指标

### 2.1 核心目标

| 目标 | 描述 |
|------|------|
| **Smart Hub 交互体验** | 会话列表、单聊/群聊、部署状态卡片、产物预览/编辑/二次交互、消息操作、上下文管理 |
| **Main Agent 协调** | PM/PMO 风格的需求理解、任务拆解、DAG 调度、并行执行、失败降级、代码冲突处理 |
| **多平台 Agent 接入** | 至少接入 2 个主流 Agent 平台；支持用户自建 Agent；统一头像/名称/能力标签 |
| **产物预览与编辑** | Agent 回复中内联预览网页、文档、PPT、代码；支持 Diff 视图、版本历史、段落引用再处理 |
| **部署到三方平台** | 一键部署到 Vercel/Cloudflare/自有服务器等，部署进度卡片实时推送 |
| **Agent 状态可见** | 实时展示每个 Agent 的运行状态、上下文用量、当前操作、活跃子 Agent |
| **权限代理** | 解析 Agent 权限请求事件，以消息卡片呈现，用户确认后回复 |
| **沙箱管理** | Docker 容器隔离，每会话独立工作区 |

### 2.2 关键成功指标

- 新用户从打开页面到完成第一次 Agent 对话的**时间 ≤ 2 分钟**
- Agent 响应消息**首字节时间 < 1 秒**
- 流式渲染无明显卡顿（60fps 打字机效果）
- 单个会话支持**10 个以上 Agent 同时在线**
- 权限确认卡片**3 秒内**推送到用户界面
- 产物预览（网页/文档/PPT）**5 秒内**完成渲染
- Main Agent 任务拆解准确率通过人工确认环节兜底

---

## 3. 用户画像与典型场景

### 3.1 用户画像

- **独立全栈开发者**：用自然语言快速搭建原型，从编码到预览到部署一站式完成
- **技术团队 (2-10人)**：多人通过群聊协同，Main Agent 拆解任务后不同 Agent 负责不同模块
- **产品经理/技术负责人**：通过 Main Agent 描述需求，查看 DAG 可视化了解任务进展，直接在聊天中预览产物
- **开源项目维护者**：通过 Agent 自动处理 issue/PR，审查代码并生成文档

### 3.2 典型场景

1. **快速原型搭建与部署**
   用户在群聊中输入需求，Main Agent 拆解任务为 DAG，多个 Agent 并行开发前后端，用户在聊天窗口中直接预览网页产物，确认后一键部署到 Vercel，部署状态卡片实时更新。

2. **日常 Bug 修复与代码审查**
   用户在单聊中 @CodeAgent 粘贴错误日志，Agent 分析后生成修复代码。用户通过内联 Diff 视图逐行确认修改，修改后可引用特定代码段落让 Agent 再次处理。

3. **多 Agent 协同开发**
   群聊中 Main Agent 将"搭建博客系统"拆解为数据库设计、API 开发、前端开发三个并行任务。CodeAgent 和另一个平台的 Agent 并行执行，完成后 ReviewAgent 审查代码，产物预览卡片展示结果。

4. **文档撰写与 PPT 生成**
   用户上传需求文档段落，Agent 生成技术文档或 PPT。用户在聊天中内联预览、编辑，引用特定段落要求 Agent 修改，最终导出。

---

## 4. 功能需求 (分阶段)

### 4.1 阶段 1：MVP — 单 Agent 聊天 + 沙箱

**目标**：跑通"用户消息 → Agent 执行 → 流式返回"的全链路，验证核心交互模型。

**状态**：✅ 完成

#### 功能列表

- [x] **基础聊天界面**：消息列表、输入框（Enter 发送/Shift+Enter 换行）、流式打字机动画、消息状态指示
- [x] **单 Agent 对话**：预设 CodeAgent，流式返回，独立气泡显示
- [x] **简易沙箱环境**：Dockerode 创建临时工作区容器，预装 Node.js/git
- [x] **会话管理**：新建/切换/列表，PostgreSQL 持久化，刷新恢复
- [x] **GitHub OAuth 认证**：白名单控制，JWT token 7 天过期
- [x] **Agent 适配器（MVP）**：spawn 子进程、stream-json 解析、错误捕获、资源回收
- [x] **WebSocket 实时通信**：JWT 认证、流式推送、心跳保活

---

### 4.2 阶段 2：多 Agent 群聊与 @ 指令

**目标**：实现群聊与 @ 指令系统，支持多 Agent 协作。引入 Agent 状态面板和权限代理。

**状态**：✅ 完成（2026-05-19）

#### 功能列表

- [x] **多 Agent 注册与发现**：Agent 配置表（DB）、预置角色（CodeAgent/ReviewAgent/DevOpsAgent）、CRUD API、群组自动分配
- [x] **@ 指令解析引擎**：前端解析 + 后端路由、多 Agent 并行、solo session 保护
- [x] **/ 指令透明透传**：/ 前缀跳过解析，原样转发，前端补全面板
- [x] **群聊界面**：按发送者分组、头像+名称、颜色区分、未读徽章、多会话切换
- [x] **@ 提及智能提示**：弹出面板、模糊搜索、键盘导航、Agent 标签（pill-style）
- [x] **多会话并行**：独立 WebSocket 连接、Solo/Group 类型
- [x] **权限代理机制**：permission_request 解析、y/n 响应投递、120s 超时 auto-deny、多 Agent 路由
- [x] **Agent 状态面板**：实时活动流（thinking/tool_use/tool_result/subagent）、Stop 控制、标签页切换
- [x] **上下文隔离**：每会话独立工作目录和沙箱、多 Agent 共享文件系统
- [x] **WebSocket 增强**：多路复用、消息类型区分、并行 prompt 文件隔离、行缓冲

---

### 4.3 阶段 3：Smart Hub 核心能力

**目标**：实现 Main Agent 协调、多 Agent 通信闭环、统一 REPL 架构。

**状态**：🟢 核心完成（2026-05-27）

#### 4.3.1 Main Agent 协调器（PM/PMO）

Main Agent 是 Smart Hub 的核心协调层，扮演类似 PM 或 PMO 的角色。

```
用户消息（无 @mention）→ Planner（群聊主持人）
用户 @planner + 触发词 → Planner（任务规划器）→ 输出 TaskPlan JSON
    ↓
Hub 解析 JSON → 渲染 TaskDAG 可视化卡片
    ↓
用户确认/修改 → 任务通过 REPL provider 分发到群内 Agent
    ↓
Agent 在线 REPL 进程接收 sendPrompt → 执行 → 流式返回结果
    ↓
AgentCoordinator 事件路由：done/error → inbox 通知 Planner
    ↓
失败降级：ManagerLoop 分析失败上下文 → replan → 人工兜底
    ↓
全部完成 → Planner 汇总报告
```

- [x] **Main Agent (Planner)**：双重身份（默认群聊主持人 + 触发词激活规划模式）
- [x] **任务拆解 Prompt**：严格 JSON schema，Zod PlanValidator 校验 + 自动重试
- [x] **任务调度**：拓扑排序 → 依赖管理 → 并行层分发到 REPL Agent（BullMQ 已移除，改为 in-process DAG）
- [x] **任务状态可视化 (TaskDAG)**：React Flow 渲染，可拖拽/连线/右键编辑
- [x] **人工确认与干预**：交互式全字段编辑（title/agentType/priority/dependsOn/expectedOutput）、单独重试
- [x] **失败降级**：自动重试 → ManagerLoop 动态重规划 → 人工介入
- [x] **DAG 状态持久化**：PlanExecution Prisma 模型 + PostgreSQL，重启恢复
- [x] **Agent 故障转移**：Agent 崩溃时排队任务自动转移到同类型 Agent
- [x] **优先级任务队列**：high/medium/low 优先级排序
- [x] **代码冲突检测**：多 Agent 并发修改同一文件时橙色高亮 + 手动裁决

#### 4.3.2 多 Agent 通信闭环（2026-05-27 新增）

- [x] **InboxManager**：Agent 间文件收件箱（`_inbox_{name}.jsonl`），支持 intervention_request/response
- [x] **AgentCoordinator + EventRoutingRules**：Hub 驱动的事件路由，自动将 Agent done/error/tool_use 事件写入相关 Agent inbox
- [x] **PermissionProfiles**：Agent 能力注册表，三层权限执行（prompt/filesystem/hub），越权操作自动委派
- [x] **IntentParser**：解析 Agent 文本输出中的 `NEEDS HELP from @AgentName` 模式，自动路由到目标 Agent
- [x] **InboxWakeup**：inbox 有新消息 + 目标 Agent REPL 在线时，实时 sendPrompt 投递
- [x] **Agent 群聊广播**：Agent 可通过 inbox 向所有群成员发送 group-chat 消息

#### 4.3.3 统一 REPL 架构（2026-05-27 新增）

- [x] **全 Agent 预激活**：Group session 连接时全部 Agent 启动为 REPL 进程，常驻在线
- [x] **砍掉 one-shot**：所有 task dispatch 和 chat 消息通过 REPL sendPrompt 复用进程
- [x] **Solo/Group 差异化内存**：solo=512MB, group=2048MB，按 session 类型分配 Docker 容器内存
- [x] **Token 用量实时管道**：SDK usage → EventParser → StateTracker → AgentCard 渲染
- [x] **Claude Agent SDK 迁移**：`@anthropic-ai/claude-agent-sdk` 替代 CLI spawn，Docker 内运行

#### 4.3.4 多平台 Agent 接入

- [x] **Provider 抽象接口**：`AbstractProvider` 定义统一生命周期
- [x] **Claude Code Provider**：完整 REPL 实现
- [x] **ProviderFactory 注册机制**：插件式注册
- [x] **第二平台 Provider**（Codex/OpenCode）
- [x] **用户自建 Agent**：API/UI 注册自定义 Agent

#### 4.3.5 消息增强交互

- [x] **消息状态指示** + **消息复制**
- [x] **Session inline 重命名**：hover 铅笔图标，回车保存
- [x] **消息气泡自适应宽度**：短文本 w-fit 收缩
- [x] **部署状态卡片**
- [ ] **上下文管理**：选择性遗忘对话/上下文窗口设置

---

### 4.4 阶段 4：产物预览与部署闭环

**目标**：实现 Agent 产物的内联预览、编辑、二次交互，以及一键部署到三方平台。

**原则**：按依赖关系顺序推进，每个功能独立可用。

```
代码 Diff 视图 ──→ 代码编辑与版本历史
    ↓
网页预览 ──→ 文档渲染 ──→ PPT 浏览
    ↓
部署到三方平台（Vercel/Cloudflare/自有服务器）
    ↓
产物二次交互（引用段落 → Agent 再处理）
```

#### 4.4.1 Diff 可视化

- [x] Agent 执行前对目标文件创建 git 快照（WorkspaceManager.recordVersion）
- [x] Agent 执行后对比快照与当前文件，生成 diff
- [x] Monaco Editor DiffEditor 渲染并排对比视图
- [x] 文件级操作：接受（保留修改）/ 拒绝（回退到快照）
- [x] Agent 内部文件自动排除（`_prompt_*`、`_env*`、`_inbox_*`、`_agent_*/`、`.claude/` 等），不生成 diff 卡片
- [x] 多 Agent 修改同一文件的冲突区域高亮为橙色
- [x] Agent 完成后自动检测文件变更，仅当有用户项目文件变更时推送通知型 diff 卡片
- [x] Diff 卡片为通知型（默认折叠、可关闭），accept/reject 为可选操作

#### 4.4.2 代码编辑与版本历史

- [x] 消息气泡中代码块支持 Monaco Editor 内联编辑
- [x] 编辑后可重新交给 Agent 处理（"让 Agent 修改这段代码"）
- [x] 文件版本历史时间线（每次 Agent 修改为一个版本节点）
- [x] 版本间 diff 对比、回退到任意历史版本

#### 4.4.3 网页预览

- [x] 沙箱内容器端口映射 + 反向代理，分配预览 URL
- [x] 右侧面板 Preview 标签页内嵌 iframe 展示预览（无 dev server 时不显示）
- [x] Vite HMR WebSocket 通过同一反向代理链路，预览自动刷新（injectHmrScript + hmrPolyfill + handlePreviewUpgrade WebSocket 代理）
- [x] 手动截取修改前后页面，以截图对比卡片发送

> **交互方式**：遵循 IM 聊天范式，预览不常驻在聊天区域。Agent 启动 dev server 后用户在右侧面板 Preview 标签页打开预览；端口检测带退避重试。

#### 4.4.4 文档渲染与文件上传

- [x] Agent 生成的 Markdown 文档在消息气泡内渲染预览（支持表格、代码块、图片）
- [x] 通用文件附件按钮（📎），支持上传多种文件类型到沙箱 workspace；PPT/PPTX 上传后内联浏览（翻页、缩略图）
- [x] 文档段落引用：选中文档段落 → "让 Agent 修改这段" → 自动生成含上下文的 prompt
- [x] ~~支持导出为 PDF/HTML~~ — 已砍掉（v0.5.0）。AgentHub 核心价值是多 Agent 协作中枢，非文档生成器。PPT 可通过 window.print() 打印导出。

> **交互方式**：文件通过输入框旁通用附件按钮上传，不再有常驻的 PPT 专用按钮。PPT 内联浏览改为消息卡片形式。

#### 4.4.5 部署到三方平台

- [x] DevOpsAgent 生成/更新 Dockerfile 和部署配置
- [x] 支持部署目标：Vercel、Cloudflare Pages、自有 Docker 服务器
- [x] 部署进度以 DeployCard 状态卡片实时推送（Building → Deploying → Success/Failed）
- [x] 部署完成卡片：URL、构建时间、镜像 SHA
- [x] 失败自动回滚到上一个成功版本

> **交互方式**：遵循 IM 聊天范式，通过输入 `/deploy <target>` 命令触发部署，不再有常驻的部署工具栏控件。DeployCard 内联展示进度。

#### 4.4.6 产物二次交互

- [x] 消息气泡段落级引用：hover 段落右侧出现引用按钮，点击自动构建含上下文的 prompt（`MessageBubble.tsx` + `agenthub:prompt-insert` 事件）
- [x] 代码块引用编辑：代码块工具栏"请修改并应用这段代码"按钮，将代码片段注入输入框
- [ ] 网页预览 iframe 内自由选区引用：用户在 Preview 面板的网页中选中任意内容 → 浮现"引用并交给 Agent"操作栏
- [ ] PPT/文档预览内选区引用：PPT 内联浏览和文档渲染中选中内容 → 引用操作
- [ ] Agent 增量处理引用内容：引用 prompt 注入结构化上下文（来源类型、文件路径、选区范围），Agent 基于引用做局部修改而非全量重写
- [ ] 交互历史可追溯：记录引用操作日志（源消息 ID、选区内容摘要、目标 Agent、处理结果消息 ID），在消息气泡中展示引用链路

---

### 4.5 阶段 5：用户设置与运行时配置

**目标**：提供用户设置面板，支持头像管理、个人偏好，以及管理员对全局 Agent 运行时参数的热更新配置。

**原则**：设置分为用户级（每人独立）和全局级（admin 可改）。运行时参数变更即时生效，无需重启。

```
用户设置面板
├── Profile 标签
│   ├── 头像上传 (本地文件, max 2MB)
│   ├── 主题切换 (dark/light)
│   └── 通知偏好
└── Agent Config 标签 (admin only)
    ├── 全局并发上限 (maxConcurrent, 默认 2, 范围 1-20)
    ├── 每会话 Agent 上限 (perSessionMax, 默认 8, 范围 1-50)
    ├── Agent 超时 (timeoutMs, 默认 300s, 范围 10-3600s)
    └── 队列超时 (queueTimeoutMs, 默认 120s, 范围 10-1800s)
```

#### 4.5.1 用户设置

- [x] 头像上传（本地文件，支持 PNG/JPG/GIF/WebP，限制 2MB）
- [x] 头像存储到服务端 `.uploads/avatars/` 目录，DB 存相对路径
- [x] 主题偏好存储到 `UserSettings` 表
- [x] 通知开关（是否接收 inbox 通知推送）

#### 4.5.2 运行时配置

- [x] `config.ts` 重构：从 frozen const 拆分为 mutable `RuntimeConfig` + immutable `config`
- [x] 运行时参数通过 getter 委托，现有代码 `config.agent.maxConcurrent` 无需改动
- [x] Admin-only PUT `/api/settings/runtime` 端点，参数范围校验
- [x] Runtime config 改变立即生效（下次 `config.agent.maxConcurrent` 读取即新值）

#### 4.5.3 设置入口

- [x] 顶部导航栏右侧齿轮图标按钮
- [x] 点击弹出右侧滑出面板（320px），包含 Profile 和 Agent Config 标签
- [x] 点击遮罩或关闭按钮关闭面板

#### 4.5.4 数据模型

```prisma
model UserSettings {
  id                   String   @id @default(uuid())
  userId               String   @unique
  user                 User     @relation(fields: [userId], references: [id])
  theme                String   @default("dark")
  notificationsEnabled Boolean  @default(true)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
}
```

**接口设计**：

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/settings/user` | 获取当前用户设置 | 登录 |
| PUT | `/api/settings/user` | 更新用户设置（头像/主题/通知） | 登录 |
| GET | `/api/settings/runtime` | 读取当前运行时配置 | 登录 |
| PUT | `/api/settings/runtime` | 更新运行时配置 | Admin |
| POST | `/api/avatar/upload` | 上传头像文件 (multipart) | 登录 |

---

## 5. 技术栈详细说明

采用**全栈 TypeScript**，前后端语言统一。

| 层级 | 技术选型 | 用途说明 |
|------|----------|----------|
| **前端** | React 18+ + Vite 5+ + TypeScript 5+ | 构建用户界面 |
|  | Tailwind CSS 3+ | 原子化样式 |
|  | shadcn/ui (Radix UI) | 无样式组件库 |
|  | Lucide Icons | 图标库 |
|  | Zustand | 轻量状态管理 |
|  | Monaco Editor | Diff 并排对比、代码编辑 |
|  | React Router DOM 6+ | 前端路由 |
| **后端 API** | Hono 4+ + Node.js 20+ | 轻量 Web 框架，原生 WebSocket |
|  | TypeScript 5+ | 类型安全 |
|  | Zod | 运行时数据校验 |
| **实时通信** | WebSocket (ws 库) | 流式输出、状态推送、权限交互 |
| **数据库/缓存** | PostgreSQL 16+ + Prisma 5+ | 持久化 |
|  | Redis 7+ | BullMQ 后端存储、会话状态缓存 |
| **任务队列** | BullMQ 5+ | Main Agent 子任务调度 |
| **Agent 接入** | `@anthropic-ai/claude-agent-sdk` (替代 child_process) | Claude Agent SDK 提供 typed streaming + session 持久化 + structured output |
|  | AbstractProvider 接口 | 多平台 Agent 统一抽象 |
| **沙箱** | Docker 24+ + dockerode | 隔离执行环境；solo 512MB / group 2048MB |
| **认证** | GitHub OAuth + JWT | 登录 + 白名单控制 |
| **反向代理** | Nginx / Caddy | 预览子域名路由、SSL |
| **产物渲染** | Monaco Editor + iframe + marked/pdf-lib | 代码/Diff、网页预览、文档/PPT 渲染 |
| **部署** | Docker Compose v2 | 单机部署 |

---

## 6. 系统架构概要

```
┌──────────────────────────────────────────────────────────────┐
│ 浏览器 (React)                                                │
│ ┌─────────┐ ┌──────────────┐ ┌────────────────────────────┐ │
│ │会话列表 │ │ 聊天主区域    │ │ 右侧上下文面板              │ │
│ │         │ │ - 消息气泡   │ │ - Agent 状态 (运行/上下文/  │ │
│ │         │ │ - @/输入框   │ │   工具/子Agent)             │ │
│ │         │ │ - 产物预览   │ │ - 文件树                    │ │
│ │         │ │   (网页/文档 │ │ - Diff 视图                 │ │
│ │         │ │    /PPT/代码)│ │ - 预览 iframe               │ │
│ │         │ │ - 部署状态卡片│ │ - 版本历史                 │ │
│ │         │ │ - 任务DAG卡片│ │                             │ │
│ └─────────┘ └──────────────┘ └────────────────────────────┘ │
└──────────┬───────────────────────────────────────────────────┘
           │ WebSocket (统一: 聊天 + 状态 + 权限 + 流式 + 部署进度)
┌──────────▼───────────────────────────────────────────────────┐
│ API 服务 (Hono)                                              │
│                                                               │
│ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │
│ │ 聊天路由 │ │ WebSocket│ │ 认证路由  │ │ Agent 管理    │  │
│ │ /api/*   │ │ /ws      │ │ /auth/*   │ │ 路由          │  │
│ └──────────┘ └────┬─────┘ └───────────┘ └───────────────┘  │
│                   │                                          │
│ ┌─────────────────▼──────────────────────────────────────┐  │
│ │ Smart Hub 协调层                                        │  │
│ │ ├── Main Agent  (需求理解 → 任务拆解 → DAG 编排)        │  │
│ │ ├── AgentCoordinator (事件路由 + 权限执行 + 委派)       │  │
│ │ ├── InboxManager + InboxWakeup (Agent 间消息 + 唤醒)    │  │
│ │ ├── IntentParser (NEEDS HELP 文本意图解析)              │  │
│ │ ├── ManagerLoop (失败重规划) + ApprovalGate (输出审批)  │  │
│ │ ├── DagPersistence (DAG 状态持久化 + 启动恢复)          │  │
│ │ ├── StateTracker (Agent 运行时快照 → 状态面板)          │  │
│ │ └── MilestoneBroadcaster (Agent 进度事件广播)           │  │
│ └─────────────────┬──────────────────────────────────────┘  │
│                   │                                          │
│ ┌─────────────────▼──────────────────────────────────────┐  │
│ │ 统一 REPL 执行层 (全 Agent 常驻在线)                     │  │
│ │ ├── 预激活：group connect → 全部 Agent 启动 REPL        │  │
│ │ ├── 复用：chat/task dispatch 通过 sendPrompt 投递       │  │
│ │ ├── 收件箱实时投递：inbox 消息直接 sendPrompt 给在线 Agent│  │
│ │ ├── 并发控制：Solo 512MB / Group 2048MB Docker 容器     │  │
│ │ └── Claude Agent SDK (typed streaming + session 持久化) │  │
│ └─────────────────┬──────────────────────────────────────┘  │
│                   │                                          │
│ ┌─────────────────▼──────────────────────────────────────┐  │
│ │ 多平台 Agent 接入层 (Provider)                          │  │
│ │ ├── ClaudeCodeProvider (已接入)                         │  │
│ │ ├── CodexProvider      (规划中)                         │  │
│ │ ├── OpenCodeProvider   (规划中)                         │  │
│ │ └── CustomAgentProvider(用户自建 Agent)                 │  │
│ └─────────────────┬──────────────────────────────────────┘  │
└───────────────────┼──────────────────────────────────────────┘
                    │
┌───────────────────▼──────────┬────────────┐
│ Redis                        │ PostgreSQL │
│ - 会话状态缓存               │ - 用户     │
│                              │ - 会话     │
│                              │ - 消息     │
│                              │ - Agent   │
│                              │ - PlanExecution (DAG 持久化)│
└──────────────────────────────┴────────────┘
                    │
┌───────────────────▼──────────────────────────────────────────┐
│ Docker 宿主机                                                 │
│ ├── 沙箱容器 (每会话一个):                                    │
│ │   ├── 工作目录 volume 挂载                                  │
│ │   ├── 预装 Node.js, git, 各平台 Agent CLI                  │
│ │   └── Agent 进程在此运行                                    │
│ ├── 反向代理 (Nginx/Caddy):                                   │
│ │   ├── API 路由 + WebSocket 升级                             │
│ │   └── 预览子域名 → 沙箱端口映射                              │
│ └── API 容器 (Hono + Redis + PostgreSQL)                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. 多平台 Agent 接入层设计

### 7.1 Provider 抽象接口

```typescript
interface AbstractProvider {
  readonly name: string;
  readonly capabilities: {
    persistentSession: boolean;   // 是否支持跨轮复用进程
    permissionProxy: boolean;     // 是否支持权限代理
    streamingOutput: boolean;     // 是否支持流式输出
    independentMemory: boolean;   // 是否有独立记忆系统
    independentConfig: boolean;   // 是否有独立配置
  };

  start(sessionId, prompt, containerId, workDir, config): Promise<void>;
  sendPrompt(prompt: string): void;  // REPL 模式：复用进程发新 prompt
  write(input: string): void;        // 权限回复等 stdin 写入
  stop(): void;
  onEvent(handler: EventHandler): void;
  isAlive(): boolean;
}
```

### 7.2 事件标准化

所有 Provider 输出统一为 `UnifiedAgentEvent`：

| 事件类型 | 含义 | 前端渲染 |
|---------|------|---------|
| `thinking` | Agent 思考/文本输出 | 消息气泡流式打字机 |
| `tool_use` | 工具调用 | Agent 状态面板更新 |
| `tool_result` | 工具结果 | Agent 状态面板更新 |
| `subagent_start` | 子 Agent 启动 | Agent 状态面板新增子 Agent |
| `subagent_result` | 子 Agent 结果 | Agent 状态面板更新 |
| `permission_request` | 权限请求 | 权限确认卡片 |
| `done` | 执行完成 | 消息状态更新、触发后续调度 |
| `error` | 执行错误 | 错误提示 |

### 7.3 接入目标

| Provider | 状态 | 备注 |
|----------|------|------|
| Claude Code | ✅ 已接入 | 首个完整实现，REPL + one-shot |
| Codex | 🔜 规划中 | OpenAI 的 Agent CLI |
| OpenCode | 🔜 规划中 | 开源 Agent CLI |
| 用户自建 | 🔜 规划中 | 通过 API/UI 注册，实现 Provider 接口 |

---

## 8. Main Agent 协调器设计

Main Agent 是 Smart Hub 的"大脑"，扮演 PM/PMO 角色。

### 8.1 双重身份

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| **群聊主持人**（默认） | 无触发词的消息 | 以对话方式自然回复，不输出 JSON，不拆解任务 |
| **任务规划器** | 包含触发词（"制定计划"/"任务拆解"/"plan"/"decompose" 等） | 探查项目 → 拆解任务 → 输出 DAG JSON |

### 8.2 调度策略

- **拓扑排序**：`dependsOn` 为空的任务进入第一并行层，依赖完成后进入下一层
- **并行度控制**：通过 `TASK_CONCURRENCY` 限制同时执行的任务数
- **失败降级**：单个任务失败不阻塞无依赖的兄弟任务；失败任务自动重试（默认 2 次），耗尽后阻塞直接依赖者
- **代码冲突处理**：多 Agent 并发修改同一文件时，Hub 检测冲突区域并以橙色高亮，交用户手动选择保留哪个版本

### 8.3 上下文传递

所有子任务共享同一 Docker 沙箱文件系统。每个子任务 prompt 注入：
- 任务指令和预期产出
- 当前项目文件树
- 前置任务的产出文件路径和摘要
- 相关技术栈信息

---

## 9. 产物预览与编辑系统

### 9.1 产物类型与渲染方式

| 产物类型 | 渲染方式 | 编辑能力 |
|---------|---------|---------|
| 网页 (HTML/React) | iframe 内嵌预览，HMR 自动刷新 | 代码编辑 → Agent 修改 |
| Markdown 文档 | 消息气泡内渲染（表格、代码块、图片） | 源码编辑 / 富文本编辑 |
| PPT/PPTX | 内联翻页浏览、缩略图导航 | 上传替换 / Agent 修改 |
| 代码文件 | Monaco Editor 语法高亮 | 内联编辑、Diff 对比、版本历史 |

### 9.2 二次交互流程

```
Agent 产出物（网页/文档/PPT/代码）
    ↓
用户在预览中选中特定内容段落
    ↓
点击"引用并交给 Agent"
    ↓
系统自动构建 prompt：上下文引用 + 用户指令
    ↓
Agent 基于引用做增量处理
    ↓
新产物替换或并排对比
```

### 9.3 版本历史

- 每次 Agent 修改文件自动记录为一个版本节点
- 版本时间线展示：时间、Agent 名称、修改摘要
- 任意两个版本间可 Diff 对比
- 可回退到任意历史版本

---

## 10. 权限代理机制

### 流程

```
Agent 子进程输出:
  {"type":"permission_request","tool":"Write","path":"/app/src/auth.ts",...}
    ↓
EventParser 识别 → PermissionBroker 生成 permissionId
    ↓
WebSocket → 前端渲染权限卡片（含操作类型、文件路径、内容预览）
    ↓
用户点击 [允许] / [拒绝]
    ↓
WebSocket 回传 permissionId + action → stdin.write("y\n" | "n\n")
    ↓
Agent 继续执行（120s 无响应自动 deny）
```

### 信任模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| 信任 (Trust ON) | 跳过权限确认，依赖沙箱隔离兜底 | 熟悉环境 |
| 正常 (Trust OFF) | 权限请求经用户确认 | 日常使用 |

---

## 11. 开发路线图与迭代计划

### 11.1 迭代原则

1. **垂直切片**：每个阶段产出可交互的完整功能
2. **尽早验证**：每完成一个阶段，内部试用收集反馈
3. **Smart Hub 优先**：协调能力是 AgentHub 的核心竞争力，执行能力交给 Agent
4. **Provider 先行**：多平台接入是差异化优势，尽早接入第二平台验证抽象层

### 11.2 各阶段概要

| 阶段 | 核心产出 | 状态 |
|------|---------|------|
| 1: MVP | 单 Agent 流式聊天 + Docker 沙箱 + GitHub OAuth | ✅ 完成 |
| 2: 多 Agent | 群聊 + @ 指令 + / 透传 + Agent 状态面板 + 权限代理 | ✅ 完成 |
| 3: Smart Hub 核心 | 统一 REPL 架构 + Agent 通信闭环 + Token 管道 + 多平台 Provider 接入 | 🟢 核心完成 |
| 4: 产物与部署 | Diff 视图 + 产物预览/编辑 + 版本历史 + 部署到三方平台 | 🟡 部分完成 |

### 11.3 阶段 1-2 详细任务分解

参见已完成状态。详细记录在 CLAUDE.md 中。

---

## 12. 非功能性需求

| 类别 | 要求 |
|------|------|
| **性能** | 消息发送到首次流式字节 < 500ms；页面首屏加载 < 2s；打字机渲染 ≥ 60fps；产物预览渲染 < 5s |
| **可用性** | 内部工具级别的可靠性；优雅降级（Redis 不可用时降级为纯 DB 模式） |
| **安全性** | 沙箱严格隔离；GitHub OAuth 白名单控制；JWT token 过期机制；生产部署双重确认 |
| **可扩展** | Agent 通过 DB 配置注册 + Provider 接口实现；沙箱镜像可定制；任务队列支持水平扩展 |
| **可维护性** | 代码规范统一（ESLint + Prettier）；核心模块单元测试覆盖率 ≥ 60% |
| **跨平台** | Provider 抽象层确保新 Agent 平台接入成本低（实现 ~200 行接口代码） |
| **用户体验** | 响应式布局 1280px+；暗黑模式；权限卡片 3s 内推送 |

---

## 13. 风险与应对

| 风险 | 概率 | 影响 | 应对措施 |
|------|------|------|----------|
| Agent CLI 兼容性更新导致 Provider 失效 | 中 | 高 | Provider 抽象层隔离具体 CLI；定期自动化冒烟测试 |
| 多平台 Agent 事件格式不统一 | 高 | 中 | `UnifiedAgentEvent` 标准化层；每个 Provider 负责格式转换 |
| 沙箱逃逸风险 | 低 | 极高 | Docker 内核安全特性 + 只读根文件系统 + 网络白名单 |
| Main Agent 拆解任务不准确 | 中 | 中 | 始终展示确认卡片给用户修正；关键步骤人工判定 |
| 多 Agent 并发修改同一文件导致冲突 | 中 | 中 | 代码冲突检测 + 橙色高亮 + 用户手动裁决 |
| API 调用费用失控 | 中 | 高 | 每用户每日额度；聊天界面消耗估算；会话预算阈值告警 |
| Docker 沙箱资源泄漏 | 中 | 低 | 会话超时自动销毁；后台定时清理孤儿容器；资源限制 |
| WebSocket 连接数过多 | 低 | 中 | 按需连接；非活跃标签降级；连接池管理 |
| 产物预览安全风险（XSS/iframe） | 中 | 高 | iframe sandbox 属性；CSP 头；预览域名隔离 |

---

> **文档结束**
> 本 PRD 伴随项目进展持续更新。Smart Hub 定位确立于 2026-05-23，后续开发均以此为准。
