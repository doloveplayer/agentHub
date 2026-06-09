# 2026-06 Changelog: Smart Hub 扩展

## 概述

Agent 生命周期重构落地、上下文管理体系建立、Skill 系统完善、Provider 扩展。

## Agent Output Workspace Editor (06-01)

**目标：** 浏览器内编辑 agent 产物文件

**关键产出：**
- Monaco Editor 集成
- 文件保存回沙箱
- 本地下载

## Custom Workspace Directory (06-01)

**目标：** 自定义工作目录

**关键产出：**
- 用户指定本机目录作为 session workspace
- Docker bind-mount 到容器 /workspace

## Planner Skill-Based Task Dispatch (06-01)

**目标：** Skill 驱动的任务分发

**关键产出：**
- Plan skill 注入 Planner 的 Claude Code skills 目录
- Planner 输出 plan.json
- Hub file watcher 检测并分发

## Agent Config Editor (06-02)

**目标：** Agent system prompt 和 skills 自定义编辑

**关键产出：**
- 混合模式表单 + Markdown 文件上传
- 全局配置生效
- 严格校验

## Context Management (06-02)

**目标：** 消除重复历史注入、结构化上下文、自动压缩

**关键产出：**
- `buildSessionContext()` 替代 `buildHistory()`
- NEEDS HELP 意图路由
- Context > 70% 自动压缩

**关联 ADR：** [ADR-005 Context Management](../adr/005-context-management.md)

## Agent Context Archive & Fault Recovery (06-02)

**目标：** Context Bus、Plan 归档、三级故障恢复

**关键产出：**
- ContextBus 全局状态黑板
- Plan 归档流水线（产物快照 + 经验提取）
- 三级故障恢复（task 重试 + plan 断点续跑 + session 快照）

## Agent Communication Wiring (06-03)

**目标：** Agent 通信线路铺设

**关键产出：**
- Agent 间消息通道
- 事件订阅机制

## ContextBus + Pinned Messages (06-03)

**目标：** ContextBus 智能上下文管理 + 消息置顶

**关键产出：**
- Token 计数 + 权重排序 + 压缩
- 消息置顶（UI 书签 + agent prompt 注入）

## Unified Agent Creation (06-04)

**目标：** 统一 agent 创建流程

**关键产出：**
- 单一 CreateAgentModal
- 模板选择 + 预置 skills
- Solo/Group 双入口

## Skill Directory & Slash Invoke (06-04)

**目标：** 完整 skill 目录移植 + / 调用

**关键产出：**
- Skill 完整目录（scripts, templates, schemas）复制到 agent 持久化目录
- `/skill-name` slash 命令调用

## OpenCode Provider (06-04)

**目标：** 接入 OpenCode 作为第二个 provider

**关键产出：**
- DeepSeek 国产模型接入
- 与 Claude Code 完全独立的 provider 实现

**关联 ADR：** [ADR-004 Multi-Provider Abstraction](../adr/004-multi-provider-abstraction.md)

## Merge Master + OpenCode (06-05)

**目标：** 合并远端 master 到 feature 分支

**关键产出：**
- 20 commits 合并
- OpenCode 功能保留

## Skill Invocation UX (06-05)

**目标：** 群聊中 skill 调用 UX 优化

**关键产出：**
- "/" popup 显示 skill 所属 agent
- 选择 skill 时自动标记 owning agent

## Plan Recovery (06-07)

**目标：** WebSocket 断线恢复 DAG 计划状态

**关键产出：**
- 前端自动从后端恢复未完成 DAG
- 用户无需手动重新确认

## 关联 ADR

- [ADR-003 Agent Lifecycle](../adr/003-agent-lifecycle.md)
- [ADR-004 Multi-Provider Abstraction](../adr/004-multi-provider-abstraction.md)
- [ADR-005 Context Management](../adr/005-context-management.md)
