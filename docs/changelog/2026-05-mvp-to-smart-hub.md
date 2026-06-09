# 2026-05 Changelog: MVP → Smart Hub

## 概述

从零搭建 AgentHub MVP，完成多 agent 群聊、Smart Hub 核心能力、产物预览与部署闭环。

## Phase 1: MVP (05-18)

**目标：** 基础 Web 聊天界面，用户登录 + Claude Code agent + Docker 沙箱 + 流式输出

**关键产出：**
- Monorepo 架构（apps/api, apps/web, packages/shared）
- 用户名/密码登录（bcrypt + JWT）
- WebSocket 流式通信
- 每 session 独立 Docker 沙箱

## Phase 2: Multi-Agent Group Chat (05-19)

**目标：** 多 agent 群聊、@mention、agent 注册表、状态面板

**关键产出：**
- Agent 注册与管理 API
- @mention 消息路由
- Agent 状态面板（在线/忙碌/离线）
- 群聊模式下的 agent 协作

## Phase 3: Smart Hub Core (05-23 ~ 05-25)

**目标：** Main Agent 协调、DAG 任务调度、消息增强

**关键产出：**
- Planner agent 双重身份（对话/规划模式）
- TaskPlan JSON → DAG 可视化
- 进程内任务调度器（taskDispatcher.ts）
- 代码冲突检测（pairwise merge）
- Provider 无关设计（AbstractProvider + ProviderFactory）

**关联 ADR：** [ADR-002 Smart Hub Core](../adr/002-smart-hub-core.md)

## Multi-Agent Core Improvements (05-25)

**目标：** DAG schema 校验、状态持久化、容错、优先级调度

**关键产出：**
- DAG state 持久化（plan.json）
- 失败重试/重规划
- 优先级调度
- 交互式 plan 编辑

## Agent Coordinator Mailbox (05-26)

**目标：** Hub 驱动的多 agent 邮箱系统

**关键产出：**
- AgentCoordinator 替代纯 prompt 驱动邮箱
- 自动事件路由
- 三层权限执行
- tool_use 级别协调

## Multi-Provider Agents (05-26)

**目标：** Codex 接入、session 重命名、自定义 agent、真实工作空间、API key 加密

**关键产出：**
- Codex provider（@openai/codex-sdk）
- Session rename + CLAUDE.md 上下文注入
- 自定义 agent 创建（Markdown 文件上传）
- Docker bind-mount 真实工作空间
- AES-256-GCM API key 加密

**关联 ADR：** [ADR-004 Multi-Provider Abstraction](../adr/004-multi-provider-abstraction.md)

## HiveWard Borrowed Features (05-26)

**目标：** 借鉴 HiveWard 5 个成熟模块修复核心缺陷

**关键产出：**
- 动态 DAG 执行（替代静态）
- 运行时审批门
- 稳健 CLI spawn
- 多平台支持框架
- 可写 DAG 可视化

## AgentCard & Planner Fixes (05-27)

**目标：** 修复 3 个关键 bug + AgentCard 重设计

**关键产出：**
- Agent ID 大小写不匹配修复
- Inbox 截断修复
- [object Object] 渲染修复
- AgentCard 3-face flip 设计

## User Settings (05-28)

**目标：** 用户设置页面

**关键产出：**
- 用户头像配置
- 管理员运行时参数调整（并发、超时）

## Agent Lifecycle Redesign (05-29)

**目标：** Agent 从 session-scoped 重构为全局实体

**关键产出：**
- Agent 全局单例 + 独立 Docker 容器
- 跨 session 记忆共享
- Solo/Group 成员管理
- AgentRuntime 统一生命周期管理

**关联 ADR：** [ADR-003 Agent Lifecycle](../adr/003-agent-lifecycle.md)

## Artifact Secondary Interaction (05-29)

**目标：** 产物二次交互

**关键产出：**
- 选区引用
- 结构化 prompt 注入
- 增量处理
- 交互历史追溯

## Solo Agent Grouped List (05-29)

**目标：** SessionList 按 Agent 分组展示

**关键产出：**
- Solo 按 Agent 分组
- Group 单独分组
- Inline 管理（删除、重命名、编辑）

## 关联 ADR

- [ADR-001 Multi-Agent Architecture](../adr/001-multi-agent-architecture.md)
- [ADR-002 Smart Hub Core](../adr/002-smart-hub-core.md)
- [ADR-004 Multi-Provider Abstraction](../adr/004-multi-provider-abstraction.md)
