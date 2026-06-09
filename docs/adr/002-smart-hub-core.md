# ADR-002: Smart Hub 核心能力

## 状态

已接受

## 背景

MVP 完成后，AgentHub 需要从被动消息管道升级为智能协作中枢——主动协调、编排、管理多 agent 协作。

## 决策

1. **Main Agent 双重身份**：默认群聊主持人（对话模式）；触发词激活规划模式（输出 TaskPlan JSON）
2. **DAG 任务调度**：进程内调度（`ws/taskDispatcher.ts`），并行执行，依赖解析，失败重试/重规划
3. **消息增强**：代码块折叠、agent 状态面板、agent 输出 inline 预览
4. **代码冲突检测**：多 agent 并发编辑同一文件时，pairwise merge 检测冲突并升级处理
5. **Provider 无关设计**：`AbstractProvider` + `ProviderFactory` 模式，支持多平台 agent 接入

## 后果

- Smart Hub 模式使 AgentHub 从聊天工具升级为协作平台
- DAG 调度引入了任务状态持久化需求（plan.json）
- 冲突检测需要文件级别的 diff 和 merge 能力

## 关联

- Changelog: `docs/changelog/2026-05-mvp-to-smart-hub.md`
- 原始 Plan: `docs/superpowers/plans/2026-05-23-phase3-smart-hub-core.md`, `2026-05-25-multi-agent-core-improvements.md`
