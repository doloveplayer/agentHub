---
name: doc-archival
description: AgentHub 文档归档管理。当完成一个功能需要更新文档、创建新的架构决策、归档旧 plan、或整理 docs 目录时使用。也适用于用户说"更新文档"、"归档 plan"、"写 ADR"、"整理 docs"等场景。确保文档三层结构（ADR → changelog → plan）始终保持清晰。
---

# AgentHub 文档归档管理

开发文档按三层结构组织，每层有不同的生命周期和用途：

```
docs/
├── adr/              # 永久 — 架构决策记录
├── changelog/        # 永久 — 按月功能总结
├── plans/            # 临时 — 仅活跃 plan
└── architecture/     # 永久 — 设计文档和报告
    ├── specs/
    └── reports/
```

## 三层结构说明

### ADR（Architecture Decision Records）— 决策层

记录影响架构的核心决策。一旦写入不修改（可 supersede）。

**何时创建：** 做出影响系统架构的决策时（如选择技术栈、改变数据模型、引入新模式）

**格式：**

```markdown
# ADR-NNN: 标题

## 状态
已接受 / 已废弃 / 已取代

## 背景
为什么需要做这个决策？什么问题驱动了它？

## 决策
具体做了什么决策？列出关键点。

## 后果
这个决策带来了什么正面和负面影响？

## 关联
- Changelog: docs/changelog/xxx.md
- Spec: docs/architecture/specs/xxx.md
```

**命名：** `NNN-kebab-case-title.md`，NNN 递增

### Changelog — 变更层

按月归档已完成的 plan。每个 plan 压缩为摘要。

**何时更新：** 每完成一个功能阶段，将 plan 摘要追加到当月 changelog

**格式：**

```markdown
## Feature Name (MM-DD)

**目标：** 一句话描述

**关键产出：**
- 产出 1
- 产出 2

**关联 ADR：** [ADR-NNN](../adr/xxx.md)
```

**压缩规则：**
- 保留：目标、关键产出、架构决策、关联 ADR
- 去掉：代码片段、实现细节、step-by-step 指令（这些在 git history 中）

### Plan — 执行层

功能的实施计划。生命周期：创建 → 执行 → 归档。

**何时创建：** 开始一个多步骤功能实现前

**何时归档：** plan 中所有 checkbox 都标记为 `[x]` 后

**归档步骤：**
1. 将 plan 摘要追加到当月 `docs/changelog/YYYY-MM-*.md`
2. 如果涉及架构决策，确保有对应的 ADR
3. 将 plan 移到 `docs/plans/.archived/`（或保留原位，由团队决定）

## 操作指南

### 完成一个功能后

1. 打开对应的 plan 文件
2. 确认所有 checkbox 已标记
3. 将摘要追加到 `docs/changelog/YYYY-MM-*.md`（格式见上）
4. 如果涉及架构决策，创建或更新 ADR

### 做出架构决策时

1. 在 `docs/adr/` 创建新 ADR
2. 编号递增（查看现有最大编号）
3. 关联到相关的 changelog 条目

### 月度整理

1. 检查当月所有已完成的 plan 是否已归档到 changelog
2. 检查是否有未创建 ADR 的架构决策
3. 清理 `docs/plans/` 中已归档的 plan

## 与其他 Skill 的关系

- **plan-management**：plan 完成后触发归档流程
- **code-review-workflow**：审查时检查文档是否同步更新
