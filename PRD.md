# AgentHub 产品需求文档 (PRD)

> **版本**：v0.2.5  
> **状态**：Phase 2 完成，Phase 3 规划中  
> **拟定人**：AgentHub 项目团队  
> **日期**：2026-05-18 · 修订 2026-05-19  

---

## 目录

1. [项目背景与愿景](#1-项目背景与愿景)
2. [核心目标与成功指标](#2-核心目标与成功指标)
3. [用户画像与典型场景](#3-用户画像与典型场景)
4. [功能需求 (分阶段)](#4-功能需求)
   - [阶段 1：MVP — 单 Agent 聊天 + 沙箱](#41-阶段-1mvp--单-agent-聊天--沙箱)
   - [阶段 2：多 Agent 群聊与 @ 指令](#42-阶段-2多-agent-群聊与--指令)
   - [阶段 3：Orchestrator 任务编排](#43-阶段-3orchestrator-任务编排)
   - [阶段 4：全流程开发增强](#44-阶段-4全流程开发增强)
5. [技术栈详细说明](#5-技术栈详细说明)
6. [系统架构概要](#6-系统架构概要)
7. [Agent 适配层设计](#7-agent-适配层设计)
8. [Agent 状态可见性设计](#8-agent-状态可见性设计)
9. [权限代理机制](#9-权限代理机制)
10. [开发路线图与迭代计划](#10-开发路线图与迭代计划)
11. [非功能性需求](#11-非功能性需求)
12. [风险与应对](#12-风险与应对)

---

## 1. 项目背景与愿景

随着大模型和 AI Agent 技术快速迭代，开发工具正从"人写代码"向"人与 AI 协同开发"演进。Claude Code 等 CLI Agent 工具已具备强大的代码生成、文件操作、任务规划能力，但现有交互方式局限在终端或 IDE 插件中，缺乏**多人/多 Agent 会话式协作、实时状态可见、以及 IM 式交互体验**。

AgentHub 的愿景是：**打造一个 IM 聊天式的多 Claude Code 协作中枢**——一个 Web 聊天界面，背后管理和编排多个 Claude Code 实例，让开发者通过自然语言与多个 AI Agent 协同完成从需求分析到部署的全流程开发工作。

### 核心原则

AgentHub 不重新实现 Claude Code 已有的能力，而是专注做好三层：

| AgentHub 负责 | 交给 Claude Code |
|--------------|-----------------|
| IM 聊天界面（多会话、消息气泡、@ 面板、/ 面板） | 代码生成、编辑、文件操作 |
| 多 Claude Code 实例的路由和调度 | 任务规划与拆解（Plan/Brainstorming） |
| 会话/消息持久化（PostgreSQL） | Shell 命令执行 |
| 沙箱容器管理（创建/销毁/挂载） | Git 操作 |
| 任务卡片可视化（DAG 展示、进度动画） | 代码审查、测试生成 |
| 网页预览（iframe + 反向代理） | 依赖分析、漏洞扫描 |
| Diff 可视化（Monaco Editor 并排对比） | |
| WebSocket 实时推送 | |
| 权限代理（解析权限请求 → 用户确认 → 回复） | |
| Agent 状态监控（运行状态、上下文用量、思考等级、子 Agent） | |

---

## 2. 核心目标与成功指标

### 2.1 核心目标

| 目标 | 描述 |
|------|------|
| 多 Agent 即时通讯交互 | 支持单聊、群聊、@ 指令召唤 Agent、/ 指令透传 Claude Code |
| Claude Code 适配层 | 管理 Claude Code 子进程生命周期，双向桥接 stdin/stdout 到 WebSocket |
| Agent 状态可见 | 实时展示每个 Agent 的运行状态、上下文用量、思考等级、活跃子 Agent |
| 权限代理 | 解析 Claude Code 权限请求事件，以消息卡片呈现，用户确认后回复 |
| 沙箱管理 | Docker 容器隔离，每会话独立工作区 |
| 任务编排 (Orchestrator) | 利用 Claude Code Plan 模式拆解任务，BullMQ 调度并行执行 |

### 2.2 关键成功指标

- 新用户从打开页面到完成第一次 Agent 对话的**时间 ≤ 2 分钟**
- Agent 响应消息**首字节时间 < 1 秒**（从 stdin 输入后计）
- 流式渲染无明显卡顿（60fps 打字机效果）
- 单个会话支持**10 个以上 Agent 同时在线**而不出现消息错乱
- 权限确认卡片**3 秒内**推送到用户界面

---

## 3. 用户画像与典型场景

### 3.1 用户画像

- **独立全栈开发者**：希望用自然语言快速搭建原型，从生成代码到预览一站式完成
- **技术团队 (2-10人)**：多人通过群聊协同，由不同 Agent 负责不同模块
- **开源项目维护者**：通过 Agent 自动处理 issue/PR，审查代码并生成文档

### 3.2 典型场景

1. **快速原型搭建**  
   用户新建 Orchestrator 会话，输入 `@planner 创建一个带有登录功能的 React 待办事项应用`，Orchestrator 调用 Claude Code Plan 模式拆解任务，多个 Agent 并行开发前后端，最终提供预览链接。

2. **日常 Bug 修复**  
   用户在单聊中 @CodeAgent，粘贴错误日志，Agent 分析后生成修复代码。用户通过 Diff 并排视图逐行确认修改。

3. **团队代码审查**  
   在群聊中 @ReviewAgent，Agent 输出可交互的审查报告。开发者逐条在聊天中回复处理，修改后 @DevOpsAgent 发布到测试环境。

---

## 4. 功能需求 (分阶段)

### 4.1 阶段 1：MVP — 单 Agent 聊天 + 沙箱

**目标**：跑通"用户消息 → Claude Code 执行 → 流式返回"的全链路，验证核心交互模型。

#### 功能列表

- [ ] **基础聊天界面**
  - 消息列表 (用户气泡 + Agent 气泡，按时间排列，自动滚到底部)
  - 消息输入框，支持 Enter 发送、Shift+Enter 换行
  - 流式输出效果 (打字机动画，逐字追加到 Agent 气泡)
  - 消息状态指示（发送中 / 流式返回中 / 完成 / 错误）

- [ ] **单 Agent 对话**
  - 预设一个 Agent 角色（CodeAgent），底层绑定 Claude Code CLI 子进程
  - 用户发送消息后，后端 spawn Claude Code 子进程，stdout 通过 WebSocket 实时推送前端
  - Agent 回复以独立气泡显示，区分发送者和消息状态

- [ ] **简易沙箱环境**
  - 后端通过 Dockerode 为每个会话创建一个临时工作区容器
  - 容器内预装 Node.js、git 等基础工具
  - Claude Code 子进程的 `cwd` 设置为容器内工作目录
  - 会话关闭或超时后自动清理容器

- [ ] **会话管理**
  - 支持新建会话、切换会话、查看会话列表
  - 会话保存在 PostgreSQL，刷新页面后恢复历史消息
  - 会话关联沙箱容器，记录容器 ID 和工作目录

- [ ] **GitHub OAuth 认证**
  - 使用 GitHub OAuth App 实现登录
  - 白名单控制：仅允许列表中 GitHub 用户登录（环境变量配置）
  - JWT session token，过期时间 7 天
  - 无认证用户自动跳转登录页

- [ ] **Claude Code 适配器（MVP 版本）**
  - `spawnAgent(sessionId, prompt)`：在沙箱容器中启动 Claude Code 子进程
  - `--output-format stream-json`：结构化流式输出，便于后端解析
  - 基础错误捕获：进程崩溃、超时、非零退出码
  - 子进程资源回收：Agent 空闲超时后自动终止

- [ ] **WebSocket 实时通信**
  - 前端连接 WebSocket，携带 session token 认证
  - 后端通过 WebSocket 推送 Claude Code stdout 流
  - 支持心跳保活 (ping/pong)

**交互原型**：  
> 用户：[登录] → [新建会话] → 输入 `Hello, 列出当前目录的文件` → 消息发送 → Agent 气泡逐字出现 `file1.ts\nfile2.ts...`

---

### 4.2 阶段 2：多 Agent 群聊与 @ 指令

**目标**：实现群聊与 @ 指令系统，支持多个 Agent 在同一会话中协作。引入 Agent 状态面板和权限代理。

**完成状态**：核心功能已交付，部分高级特性延后至 Phase 3。2026-05-19 完成。

#### 功能列表

- [x] **多 Agent 注册与发现**
  - Agent 配置表 (数据库)，字段：名称、显示名称、角色描述、system prompt、permission mode
  - 预置 Agent 角色（均为 Claude Code 实例，差异在 system prompt）：

    | Agent | System Prompt 差异 | 用途 |
    |-------|-------------------|------|
    | CodeAgent | 默认，专注代码生成 | 写代码、修 Bug |
    | ReviewAgent | 注入"你是代码审查专家，只审查不修改" | 代码审查 |
    | DevOpsAgent | 注入"你是部署运维专家" | 打包、部署 |

  - 后端启动时自动 seed 3 个默认 Agent（`apps/api/src/defaultAgents.ts`，`seed.ts` + `index.ts` 共享引用）
  - Agent CRUD API（`GET/POST/PUT/DELETE /api/agents`），支持自定义注册
  - 群组 Session 创建时自动分配全部活跃 Agent（`sessions.ts:64-69`）
  - **实现文件**: `apps/api/prisma/schema.prisma`(SessionAgent 模型), `apps/api/src/routes/agents.ts`

- [x] **@ 指令解析引擎**
  - 前端 `mentionParser.ts` 解析消息中的 `@AgentName`，分割为多段指令，每段路由到对应 Agent
  - 解析规则：`@` 开头匹配已注册 Agent 名称（case-insensitive prefix），遇下一个 `@` 或字符串结束为边界
  - 未 @ 任何 Agent 的消息在 solo session 默认发给唯一 Agent，在 group session 待实现广播
  - 同一消息中可 @ 多个 Agent，后端并行启动对应子进程（共享同一 Docker 沙箱）
  - Solo session 拒绝 mentions（400 错误）
  - **实现文件**: `apps/web/src/lib/mentionParser.ts`, `apps/api/src/routes/chat.ts`, `apps/api/src/ws/handler.ts`

- [x] **/ 指令透明透传**
  - 后端检测 `/` 前缀（`handler.ts:236`），跳过 system prompt 注入和 mention 解析，原样转发给 Claude Code
  - Claude Code 自行识别和执行 skills/commands
  - 前端 `/` 补全面板延后至 Phase 3
  - **实现文件**: `apps/api/src/ws/handler.ts`（`isSlashCommand` 分支）

- [x] **群聊界面**
  - 消息按发送者分组显示（Human / CodeAgent / ReviewAgent / DevOpsAgent，各带头像 + 名称）
  - 人类用户用 GitHub 头像，Agent 用彩色圆形 + 首字母（C/R/D）
  - 群聊顶部参与者信息栏（`ChatView.tsx:140-148`）
  - 消息气泡根据发送者使用不同颜色（CodeAgent=紫, ReviewAgent=绿, DevOpsAgent=橙）
  - 未读红点、多标签页延后至 Phase 3
  - **实现文件**: `apps/web/src/components/ChatView.tsx`, `MessageBubble.tsx`, `SessionList.tsx`

- [x] **@ 提及智能提示**
  - 输入 `@` 弹出 Agent 选择面板（`AgentMentionPopup.tsx`），支持模糊搜索和键盘导航（↑↓ 选择，Enter 确认，Esc 关闭）
  - 面板显示 Agent 的能力描述和快捷键（`@c`/`@r`/`@d`）
  - 选中后在输入框上方显示 Agent 标签（pill-style，可移除）
  - 根据上下文推荐 Agent 延后至 Phase 3
  - **实现文件**: `apps/web/src/components/AgentMentionPopup.tsx`, `MessageInput.tsx`

- [x] **多会话并行**
  - 左侧会话列表，可在不同会话间快速切换
  - 每个会话独立维护 WebSocket 连接（`socketPool` Map）
  - Solo / Group 两种会话类型（`Session.type` 字段）
  - 多标签页、未读消息红点延后至 Phase 3
  - **实现文件**: `apps/web/src/hooks/useChat.ts`, `apps/api/src/routes/sessions.ts`

- [ ] **权限代理机制**（→ Phase 3）
  - `permission_request` 事件已被 EventParser 捕获
  - 当前使用 `--dangerously-skip-permissions` 跳过权限确认（trustMode=true）
  - 多 Agent 模式下权限路由到正确 Agent 需要 stdin 改造，延后至 Phase 3
  - 前端 401 时自动清除 token 并跳转登录页（`api.ts:20-23`）

- [x] **Agent 状态面板（右侧上下文面板）**
  - **实时活动流**（Phase 2.5 交付）：
    - 💭 thinking — Agent 思考过程文本（截断 120 字），实时流式更新
    - 🔧 tool_use — 工具调用，显示 toolName + input 摘要
    - 📋 tool_result — 工具结果截断预览
    - 🔀 subagent_start / ✅ subagent_result — 子 Agent 活动
    - 活动流自动滚到底部，最近 20 条事件
  - **Agent 控制**：
    - ■ Stop 按钮 — 运行中 Agent 可随时终止（WebSocket `stop_agent` 消息 → 后端 kill 进程 + 清理状态）
    - 红色脉冲动画指示运行中
  - 标签页切换：[Files] [Agents◎] [Tasks]（Files/Tasks 为 Phase 3 占位）
  - 状态数据来源：后端 `handler.ts` 将 `text`/`tool_use`/`tool_result`/`subagent` 事件通过 `agent_status` WebSocket 消息流式推送到前端
  - 思考等级、精确上下文用量延后至 Phase 3（需 StateTracker）
  - **实现文件**: `apps/web/src/components/AgentCard.tsx`, `AgentStatusPanel.tsx`, `apps/api/src/ws/handler.ts`

- [x] **上下文隔离**
  - 每个会话独立的工作目录和沙箱容器
  - 文件系统变化仅影响当前会话
  - 同一会话内的多个 Agent 共享同一文件系统（单 Docker 容器，bind-mount workspace）

- [x] **WebSocket 增强**
  - 支持按会话分组的多路复用（`socketPool` Map）
  - 消息类型区分：chat、stream_chunk、stream_end、stream_error、agent_status（含 thinking/tool_use/tool_result/subagent_start/subagent_result）、permission_request、stop_agent
  - 每 Agent 独立 prompt 文件避免并行覆盖（`_prompt_{messageId}.txt`）
  - 跨 Docker 帧行缓冲（`ClaudeCodeProcess.partialLine`）防止 JSON 事件丢失
  - **实现文件**: `apps/api/src/ws/handler.ts`, `apps/api/src/agent/ClaudeCodeProcess.ts`

- [x] **补充特性（计划外，开发中发现）**
  - 后端启动时自动清理残留 streaming 消息（`index.ts` startup cleanup）
  - Auth 中间件 + WebSocket 连接双重检查用户是否存在（防 DB 重置后旧 token 导致 FK 错误）
  - Agent 并行 prompt 文件隔离（避免同一容器内多 Agent prompt 互相覆盖）
  - 401 响应自动清除 token + 跳转登录页
  - Agent 执行超时（5 分钟默认）和并发限制（per-session 3，global 5）
  - 群组 Session 创建时自动分配全部活跃 Agent

**交互原型**：  
> 用户创建群聊"我的全栈项目"，Agent 自动加入。输入 `@CodeAgent 写一个 Express 服务器` → 右侧 CodeAgent 卡片实时显示活动流（thinking → tool_use → tool_result）→ Agent 气泡流式输出代码 → 输入 `@ReviewAgent 检查刚才的代码` → ReviewAgent 卡片开始活动，输出审查意见。右侧面板同时显示两个 Agent 的活动状态，运行中 Agent 可随时按 ■ 停止。

---

### 4.3 阶段 3：Orchestrator 任务编排

**目标**：引入 Planner Agent（一个特殊的 Claude Code 实例），利用 Claude Code 的 Plan/Brainstorming 能力自动拆解用户需求为子任务 DAG，通过 BullMQ 调度多个 Agent 并行执行。

#### 核心设计

Orchestrator 不自行拆解任务，而是**调用一个专用的 Claude Code 实例（Planner）**来做规划。AgentHub 负责：调度执行 + 状态可视化 + 人工确认 + 结果聚合。

```
用户复杂需求
    ↓
Orchestrator 启动 Planner (Claude Code 实例，注入规划 role system prompt)
    ↓
Planner 利用 Plan/Brainstorming 能力 → 输出结构化 JSON 任务计划
    ↓
AgentHub 解析 JSON → 生成任务卡片 (DAG 可视化)
    ↓
用户确认/修改计划 → BullMQ 调度引擎
    ↓
并行调度多个 Agent → 共享同一沙箱文件系统 → 执行结果汇总
```

#### 功能列表

- [ ] **Planner Agent**
  - 作为一个特殊 Agent 注册，底层也是 Claude Code 子进程
  - System prompt 注入规划角色：要求将需求拆解为结构化 JSON，包含任务依赖关系
  - 输出格式约束：严格的 JSON schema，每个子任务含 id、title、description、agentType、dependsOn、expectedOutput
  - 执行前先探查项目上下文（文件树、package.json 等），确保计划可落地

- [ ] **任务拆解 Prompt 设计**
  ```
  你是一个软件工程任务规划专家。
  收到开发需求后，将其拆解为可并行执行的子任务。
  先执行 ls 了解项目结构，再拆解。输出严格 JSON：

  {
    "planTitle": "...",
    "tasks": [
      {
        "id": "task-1",
        "title": "设计数据库模型",
        "description": "使用 Prisma 定义 User 和 Post 模型...",
        "agentType": "CodeAgent",
        "dependsOn": [],
        "expectedOutput": "prisma/schema.prisma"
      }
    ]
  }
  ```

- [ ] **任务队列与调度**
  - 使用 BullMQ 管理子任务队列
  - 依赖关系支持：`dependsOn` 指定的任务完成后，后续任务才被调度
  - 无依赖任务自动并行执行
  - 每个子任务在沙箱中启动对应的 Claude Code 实例，注入任务指令和上下文
  - 上下文传递：任务 prompt 中自动注入前置任务的产出文件列表和执行摘要

- [ ] **上下文传递机制**
  - 所有 Agent 共享同一 Docker 沙箱，文件系统天然共享
  - 每个子任务启动时，prompt 中注入：
    - 任务指令
    - 当前项目文件树
    - 前置任务的产出文件路径和摘要
    - 相关技术栈信息
  - 子任务间通过文件系统交换数据（Agent A 生成文件 → Agent B 读取）

- [ ] **任务状态可视化**
  - 聊天窗口中出现"任务卡片"消息，展示 DAG 树状结构
  - 节点状态：
    - ⏸ 灰色 — 等待依赖完成
    - 🔄 蓝色旋转 — 执行中
    - ✅ 绿色 — 完成
    - ❌ 红色 — 失败
  - 可展开节点查看该子任务的实时执行日志（流式输出）
  - 底部显示整体进度：`4/7 完成  2 运行中  1 等待中`

- [ ] **人工确认与干预**
  - 拆解后的 DAG 以任务卡片展示，提供"确认执行"和"修改"按钮
  - 用户可修改单个子任务指令后重新执行
  - 用户可调整 DAG 依赖关系（拖拽或文本编辑）
  - 执行中随时可暂停排队中的任务

- [ ] **失败处理**
  - 单个子任务失败不阻塞无依赖的其他任务
  - 依赖失败任务的后继任务自动跳过，标记"等待上游修复"
  - 失败任务错误日志完整保留，可展开查看
  - 用户可修改指令后单独重试失败任务，或整体重跑

- [ ] **结果聚合**
  - 所有子任务完成后，Orchestrator 生成汇总报告卡片
  - 列出所有文件变更、新增/删除的文件清单
  - 提供"查看 Diff"快捷入口跳转到阶段 4 的 Diff 视图

**交互原型**：  
> 用户 `@planner 搭建一个博客网站，支持文章发布和评论` → Planner 回复一张任务卡片：
> ```
> ✅ 需求分析 (Planner) 
>    ↓
> ✅ 数据库设计 (CodeAgent) 
>    ├─ 🔄 用户 API (CodeAgent-A)  
>    ├─ 🔄 文章 API (CodeAgent-B)  
>    └─ ⏸ 评论 API (CodeAgent-C) 
>    ↓
> ⏸ 前端集成 (CodeAgent-Main)
> ```
> 用户点击"确认执行"，卡片变为进度视图，各节点依次点亮完成。

---

### 4.4 阶段 4：全流程开发增强

**目标**：逐步完善 Diff 可视化、网页预览、代码审查等开发者刚需功能，形成从编码到部署的闭环。

**原则**：不设严格时间线，按依赖关系顺序推进。每个功能独立可用。

#### 执行顺序

```
Diff 可视化 ──→ 代码审查
    ↓
网页预览
    ↓
一键部署

测试生成与执行 (独立，可并行)
依赖与安全检查 (独立，可并行)
```

---

#### 4.4.1 Diff 可视化

**AgentHub 做**：文件版本追踪 + Monaco Editor 并排对比 + 逐行操作 UI。

**Claude Code 做**：实际文件修改。

- [ ] Agent 执行前，后端对目标文件创建快照（copy 或 git stash）
- [ ] Agent 执行完成后，后端对比快照与当前文件，生成 diff
- [ ] 前端使用 Monaco Editor DiffEditor 渲染并排对比视图
- [ ] 逐行操作：接受（保留修改）/ 拒绝（回退到快照）
- [ ] 多 Agent 修改同一文件时，冲突区域高亮为橙色，手动选择版本
- [ ] Agent 完成后自动触发 Diff 生成，以消息卡片形式推送

---

#### 4.4.2 网页预览

**AgentHub 做**：反向代理 + iframe 嵌入。

**Claude Code 做**：在沙箱内启动开发服务器。

- [ ] 沙箱内容器端口映射到宿主机随机端口
- [ ] Nginx/Caddy 反向代理，分配 `preview-{sessionId}.internal` 子域名
- [ ] 前端聊天窗口内嵌 iframe 展示预览，底部可拖拽调整高度
- [ ] 右侧上下文面板可固定/取消固定预览视图
- [ ] Vite HMR WebSocket 通过同一反向代理链路走，预览自动刷新
- [ ] 可选：自动截取修改前后页面，以截图对比卡片发送

---

#### 4.4.3 代码审查

**AgentHub 做**：渲染可交互的审查报告卡片，点击定位到代码行。

**Claude Code 做**：以审查角色分析代码，生成结构化报告。

- [ ] ReviewAgent 自动扫描 Agent 生成的代码
- [ ] 生成分级报告卡片：🔴高危 / 🟡警告 / 🟢建议
- [ ] 点击问题项 → 右侧面板跳转到 Diff 视图对应行
- [ ] 支持逐条标记"已修复"或"忽略"
- [ ] 审查报告持久化，可在消息历史中回看

---

#### 4.4.4 测试生成与执行

**AgentHub 做**：触发测试执行，展示测试报告卡片。

**Claude Code 做**：编写测试文件，执行测试。

- [ ] TestAgent 分析目标文件，生成测试代码
- [ ] 在沙箱中执行测试，收集结果（通过/失败/错误详情）
- [ ] 测试报告卡片：用例列表 + 状态 + 耗时
- [ ] 失败用例附带堆栈信息，"让 Agent 修复"按钮一键重试

---

#### 4.4.5 依赖与安全检查

**AgentHub 做**：解析检查结果，渲染升级建议卡片。

**Claude Code 做**：执行 `npm audit` 等相关命令，分析依赖。

- [ ] DepsAgent 分析 `package.json` 等依赖文件
- [ ] 检查安全漏洞（关联 CVE 编号和严重程度）
- [ ] 检查过期包（当前版本 → 最新版本）
- [ ] "一键升级"按钮（全部升级 / 逐个选择）
- [ ] 结果为卡片形式，可持久化查看

---

#### 4.4.6 一键部署

**AgentHub 做**：编排 Docker build → push → deploy 流程，推送实时日志。

**Claude Code 做**：生成 Dockerfile、部署配置。

- [ ] DevOpsAgent 生成/更新 Dockerfile 和部署配置
- [ ] AgentHub 执行 `docker build`，日志实时推送到聊天窗口
- [ ] 支持多环境配置（开发/测试/生产，环境变量区分）
- [ ] 生产部署要求双重确认（输入确认短语 + 点击确认按钮），缺一不可
- [ ] 部署完成卡片：URL、构建时间、镜像 SHA
- [ ] 失败自动回滚到上一个成功镜像，Agent 汇报失败原因

---

## 5. 技术栈详细说明

采用 **全栈 TypeScript 快速启动栈**，前后端语言统一。

| 层级 | 技术选型 | 版本要求 | 用途说明 |
|------|----------|----------|----------|
| **前端** | React | 18+ | 构建用户界面 |
|  | Vite | 5+ | 开发服务器与构建工具 |
|  | TypeScript | 5+ | 全栈类型安全 |
|  | Tailwind CSS | 3+ | 原子化样式，快速构建聊天 UI |
|  | shadcn/ui (Radix UI) | latest | 无样式组件库，对话框、下拉菜单、命令面板 |
|  | Lucide Icons | latest | 图标库 |
|  | Zustand | latest | 轻量状态管理 |
|  | React Router DOM | 6+ | 前端路由 |
|  | Monaco Editor | latest | Diff 并排对比（阶段 4） |
| **后端 API** | Hono | 4+ | 轻量 Web 框架，原生 WebSocket 支持 |
|  | Bun (或 Node.js) | 1.1+ / 20+ | JavaScript 运行时 |
|  | TypeScript | 5+ | 类型安全 |
|  | Zod | latest | 运行时数据校验 |
| **实时通信** | WebSocket (ws 库) | 8+ | 统一用于流式输出、状态推送、权限交互 |
| **数据库/缓存** | PostgreSQL | 16+ | 持久化用户、会话、消息 |
|  | Prisma | 5+ | TypeScript ORM |
|  | Redis | 7+ | 会话状态缓存、在线状态、BullMQ 后端存储 |
| **任务队列** | BullMQ | 5+ | Orchestrator 子任务调度（阶段 3） |
| **Agent 适配器** | child_process (Node.js) | 内置 | 管理 Claude Code CLI 子进程 |
|  | stream-json 行解析 | - | 解析 Claude Code stream-json 输出 |
| **沙箱** | Docker + dockerode | 24+ | 隔离执行环境 |
| **认证** | GitHub OAuth App | - | 登录 + 白名单控制 |
|  | jsonwebtoken | latest | JWT session token |
| **反向代理** | Nginx / Caddy | - | 预览子域名路由、SSL |
| **部署** | Docker Compose | v2 | 单机部署，适合内部工具 |
| **监控与日志** | Pino | latest | 结构化日志 |

---

## 6. 系统架构概要

```
┌──────────────────────────────────────────────────────────────┐
│ 浏览器 (React)                                                │
│ ┌─────────┐ ┌──────────────┐ ┌────────────────────────────┐ │
│ │会话列表 │ │ 聊天主区域    │ │ 右侧上下文面板              │ │
│ │         │ │ - 消息气泡   │ │ - Agent 状态 (运行状态/     │ │
│ │         │ │ - @/输入框   │ │   上下文/思考等级/子Agent)  │ │
│ │         │ │ - 权限卡片   │ │ - 文件树                    │ │
│ │         │ │ - 任务卡片   │ │ - Diff 视图                 │ │
│ │         │ │ - 审查/测试  │ │ - 预览 iframe               │ │
│ │         │ │   报告卡片   │ │                             │ │
│ └─────────┘ └──────────────┘ └────────────────────────────┘ │
└──────────┬───────────────────────────────────────────────────┘
           │ WebSocket (统一: 聊天 + 状态 + 权限 + 流式)
┌──────────▼───────────────────────────────────────────────────┐
│ API 服务 (Hono)                                              │
│                                                               │
│ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │
│ │ 聊天路由 │ │ WebSocket│ │ 认证路由  │ │ Agent 管理    │  │
│ │ /api/*   │ │ /ws      │ │ /auth/*   │ │ 路由          │  │
│ └──────────┘ └────┬─────┘ └───────────┘ └───────────────┘  │
│                   │                                          │
│ ┌─────────────────▼──────────────────────────────────────┐  │
│ │ Agent 适配层                                            │  │
│ │ ├── ClaudeCodeProcess  (子进程 spawn/stdin/stdout/kill) │  │
│ │ ├── EventParser        (stream-json 行解析, 事件分类)   │  │
│ │ ├── PermissionBroker   (权限请求 → 卡片 → 用户响应)     │  │
│ │ └── StateTracker       (Agent 运行时状态快照 → Redis)   │  │
│ └─────────────────┬──────────────────────────────────────┘  │
└───────────────────┼──────────────────────────────────────────┘
                    │
┌───────────────────▼──────────┬────────────┬──────────────────┐
│ Redis                        │ PostgreSQL │ BullMQ           │
│ - 会话状态/在线状态          │ - 用户     │ - 任务队列       │
│ - StateTracker 快照          │ - 会话     │ - DAG 依赖       │
│ - BullMQ 存储               │ - 消息     │                  │
│                              │ - Agent   │                  │
└──────────────────────────────┴────────────┴──────────────────┘
                    │
┌───────────────────▼──────────────────────────────────────────┐
│ Docker 宿主机                                                 │
│ ├── 沙箱容器 (每会话一个):                                    │
│ │   ├── 工作目录 volume 挂载                                  │
│ │   ├── 预装 Node.js, git                                    │
│ │   └── Claude Code CLI 在此运行                              │
│ ├── 反向代理 (Nginx/Caddy):                                   │
│ │   ├── API 路由                                              │
│ │   ├── WebSocket 升级                                        │
│ │   └── 预览子域名 → 沙箱端口映射                              │
│ └── API 容器 (Hono + Redis + PostgreSQL)                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 7. Agent 适配层设计

### 7.1 子进程管理 (ClaudeCodeProcess)

```
spawn → stdin.write(prompt) → stdout stream → EventParser
                                    ↓
                            WebSocket → 前端 (流式打字机)
                                    ↓
                            process exit → 清理资源 → 通知前端完成
```

- 子进程配置：
  - 正常模式：`claude -p <prompt> --output-format stream-json`（权限请求通过 PermissionBroker 处理）
  - 信任模式：`claude -p <prompt> --output-format stream-json --dangerously-skip-permissions`（跳过所有权限确认）
- 工作目录：`cwd` 设置为会话沙箱容器的工作目录
- 环境变量：透传 API Key 等必要凭证
- 资源回收：Agent 空闲超时自动终止子进程；会话关闭时强制终止
- 错误处理：进程崩溃、超时、非零退出码均通过 WebSocket 通知前端

### 7.2 事件解析 (EventParser)

解析 Claude Code `--output-format stream-json` 输出的每一行 JSON，分类处理：

| 事件类型 | 处理方式 |
|---------|---------|
| `assistant` (text) | 推送到前端打字机渲染 |
| `tool_use` | 更新 Agent 状态面板（当前操作） |
| `tool_result` | 更新文件列表、上下文用量 |
| `permission_request` | 转入 PermissionBroker |
| `subagent_start` / `subagent_result` | 更新子 Agent 列表 |
| `system` (init/status) | 更新会话元信息 |

### 7.3 状态追踪 (StateTracker)

- 每个活跃 Agent 维护一份运行时状态快照在 Redis 中
- 状态字段：status、currentTool、openedFiles、tokenUsage、thinkingLevel、subAgents
- EventParser 每收到事件即更新对应字段
- WebSocket 按固定频率（500ms）推送状态快照到前端，避免事件洪峰
- Agent 进程退出后，状态设为 offline，保留最后一次快照供查看

---

## 8. Agent 状态可见性设计

右侧上下文面板的"Agent 状态"标签页：

```
┌─────────────────────────────────────────┐
│ Agent 控制面板                           │
├─────────────────────────────────────────┤
│ 当前会话 Agents:                         │
│                                         │
│ ┌ CodeAgent ────────────────────────┐  │
│ │ 状态: 🟢 运行中                    │  │
│ │ 思考等级: max (深层推理)            │  │
│ │ 当前操作: Bash(ls /app/src)        │  │
│ │ 上下文: ████████░░ 12,450/200,000  │  │
│ │ 修改文件:                          │  │
│ │   • src/index.ts (已修改)          │  │
│ │   • package.json (新增)            │  │
│ │ 活跃子 Agent:                      │  │
│ │   └ Explore:"搜索路由配置" 🟡运行   │  │
│ └───────────────────────────────────┘  │
│                                         │
│ ┌ ReviewAgent ──────────────────────┐  │
│ │ 状态: 🟡 等待用户确认              │  │
│ │ 思考等级: standard                 │  │
│ │ 待确认: Write(src/auth.ts)         │  │
│ │ [允许] [拒绝]                      │  │
│ └───────────────────────────────────┘  │
│                                         │
│ [文件树] [Agent状态◎] [任务卡片]        │
└─────────────────────────────────────────┘
```

### 状态数据来源映射

| 显示字段 | 来源 |
|---------|------|
| 运行状态 | StateTracker 快照中的 status 字段 |
| 思考等级 | Claude Code 启动时的 effort 设置 / 运行时事件 |
| 当前操作 | `tool_use` 事件的 name + input |
| 上下文用量 | `system` 事件中的 token 信息 |
| 修改文件 | `tool_use` (Write/Edit) + `tool_result` 涉及的文件 |
| 活跃子 Agent | `subagent_start` 事件（嵌套展示，带各自状态） |
| 待确认权限 | `permission_request` 事件（渲染为允许/拒绝按钮） |

---

## 9. 权限代理机制

### 流程

```
Claude Code 子进程输出:
  {"type":"permission_request","tool":"Write","path":"/app/src/auth.ts",...}
    ↓
EventParser 识别 → PermissionBroker 生成 permissionId
    ↓
WebSocket → 前端渲染权限卡片
    ↓
┌─────────────────────────────────────────┐
│ 🔐 CodeAgent 请求权限                    │
│ 操作: 写入文件                           │
│ 路径: /app/src/auth.ts                  │
│ 内容预览: [展开查看变更内容]              │
│ [允许] [拒绝]                            │
└─────────────────────────────────────────┘
    ↓
用户点击 → WebSocket 回传 permissionId + action
    ↓
PermissionBroker: stdin.write("allow\n" | "deny\n")
    ↓
Claude Code 继续执行
```

### 信任模式开关

每个会话可设置信任级别，存储于 Session 模型中：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| 正常 (默认) | 所有权限请求经用户确认 | 日常使用 |
| 信任 | 跳过权限确认，依赖沙箱隔离兜底 | 熟悉环境、高风险操作已知的场景 |

切换信任模式需用户手动操作，界面提示安全风险。

---

## 10. 开发路线图与迭代计划

### 10.1 迭代原则

1. **垂直切片**：每个阶段产出可交互的完整功能
2. **尽早验证**：每完成一个阶段，内部试用收集反馈
3. **可回退**：所有代码在 Git 管理下
4. **Claude Code 优先**：能用 Claude Code 完成的功能不在 AgentHub 中重复实现

### 10.2 各阶段概要

| 阶段 | 周期 | 核心产出 | 状态 |
|------|------|---------|------|
| 1: MVP | 2-3 周 | 单 Agent 流式聊天 + Docker 沙箱 + GitHub OAuth | ✅ 完成 |
| 2: 多 Agent | 2-3 周 | 群聊 + @ 指令 + / 透传 + Agent 实时活动流 + 终止控制 | ✅ 完成（权限代理 → Phase 3） |
| 3: Orchestrator | 3-4 周 | Planner + DAG 任务卡片 + BullMQ 调度 + 失败处理 | 🔜 |
| 4: 全流程增强 | 按依赖顺序，不设时限 | Diff → 预览 → 审查 → 部署 → 测试 → 依赖检查 | 🔜 |

### 10.3 阶段 1 详细任务分解

**后端任务**
- [ ] 初始化 monorepo 项目结构（`apps/api`、`apps/web`、`packages/shared`）
- [ ] 搭建 Hono 服务，基础中间件（CORS、日志、错误处理、JWT 验证）
- [ ] 实现 GitHub OAuth 登录流程（/auth/github → /auth/callback → JWT 签发）
- [ ] 白名单中间件：检查 GitHub username 是否在允许列表
- [ ] 集成 Prisma，定义 User、Session、Message 模型
- [ ] 实现会话 CRUD API（创建、列表、详情、删除）
- [ ] 实现消息持久化（发送时写入 DB，加载历史时读取）
- [ ] 搭建 WebSocket 服务（/ws），JWT 认证连接，心跳保活
- [ ] 实现 Claude Code 适配器：
  - ClaudeCodeProcess：spawn 子进程，设置 cwd 为沙箱路径
  - EventParser：解析 stream-json 行，分类处理
  - 流式输出通过 WebSocket 推前端
- [ ] 使用 Dockerode 为会话创建沙箱容器（挂载独立 volume）
- [ ] 会话关闭/超时后自动清理容器和子进程

**前端任务**
- [ ] 用 Vite 初始化 React + TypeScript 项目，配置 Tailwind 和 shadcn/ui
- [ ] 实现 GitHub OAuth 登录页和回调处理
- [ ] 简易聊天 UI 组件：ChatView（消息列表 + 输入框）、MessageBubble（user/agent 样式）
- [ ] 流式打字机效果：WebSocket 接收 chunk → 逐字追加到 Agent 气泡
- [ ] 会话列表组件（SessionList）：展示标题、最新消息预览、新建/切换
- [ ] useChat hook：管理 WebSocket 连接、消息发送、流式接收、消息状态
- [ ] 前后端联调，确保链路通畅

**DevOps**
- [ ] 编写 docker-compose.yml：API 服务、PostgreSQL、Redis
- [ ] 配置 Nginx/Caddy 反向代理模板
- [ ] 确保 Docker 宿主机可被 API 容器访问（挂载 Docker socket）

**里程碑**：浏览器中登录 → 创建会话 → 与 Claude Code Agent 对话 → 流式打字机效果 → 会话可保存恢复。

---

## 11. 非功能性需求

| 类别 | 要求 |
|------|------|
| **性能** | 消息发送到首次流式字节 < 500ms；页面首屏加载 < 2s；打字机渲染 ≥ 60fps |
| **可用性** | 内部工具级别的可靠性；优雅降级（Redis 不可用时降级为纯 DB 模式） |
| **安全性** | 沙箱严格隔离；GitHub OAuth 白名单控制；JWT token 过期机制；信任模式需显式确认开启 |
| **可扩展** | Agent 角色通过 DB 配置注册；沙箱镜像可定制；任务队列支持水平扩展 worker |
| **可维护性** | 代码规范统一（ESLint + Prettier）；核心模块单元测试覆盖率 ≥ 60% |
| **用户体验** | 响应式布局，适配 1280px+ 桌面端；支持暗黑模式；权限确认卡片 3 秒内到前端 |

---

## 12. 风险与应对

| 风险 | 概率 | 影响 | 应对措施 |
|------|------|------|----------|
| Claude Code CLI 兼容性更新导致适配器失效 | 中 | 高 | 抽象适配层（ClaudeCodeProcess 封装），仅依赖 `--output-format stream-json` 标准接口；定期自动化冒烟测试 |
| Claude Code 非交互模式不稳定 | 中 | 中 | 备选方案：降级为直接调用 Anthropic API；priority 上专项测试 `--dangerously-skip-permissions` 的稳定性 |
| 沙箱逃逸风险 | 低 | 极高 | Docker 内核安全特性 + 只读根文件系统；沙箱网络出站默认禁止，仅白名单放行；定期安全审计 |
| Planner 拆解任务不准确 | 中 | 中 | 利用 Claude Code 自身的 Plan/Brainstorming 能力（比自研拆解强）；始终展示确认卡片给用户修正；关键步骤人工判定 |
| 多 Agent 并发修改同一文件导致冲突 | 中 | 中 | 文件级悲观锁（先占先得）；Diff 视图时检测多 Agent 修改并高亮冲突 |
| API 调用费用失控 | 中 | 高 | 设置每用户每日额度；简单任务使用 `--model haiku`；聊天界面显示消耗估算；会话预算阈值告警 |
| Docker 沙箱资源泄漏 | 中 | 低 | 会话超时自动销毁容器和 volume；后台定时清理孤儿容器；设置容器资源限制（CPU/内存） |
| WebSocket 连接数过多 | 低 | 中 | 按需连接（仅活跃会话标签维持 WebSocket）；非活跃标签降级为轮询或仅显示最后状态；连接池管理 |

---

> **文档结束**  
> 本 PRD 将伴随项目进展持续更新，阶段性目标可根据实际开发情况灵活调整。
