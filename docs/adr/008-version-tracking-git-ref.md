# ADR-008: 版本追踪 Git ref 策略

## 状态

已接受

## 背景

多 Agent 并发修改同一工作目录时，需要精确追踪每个 Agent 的修改范围，生成准确的 Diff。

## 决策

1. **git stash create 快照**：轻量快照，不修改 working tree 和 index，返回 commit SHA
2. **branch fallback**：stash 失败时创建临时分支 `agenthub-snapshot-{sessionId}-{timestamp}`
3. **ref-to-ref Diff**：基于 `git diff ref1 ref2` 对比两个快照，而非 ref-to-working-tree
4. **stash apply 回滚**：`WorkspaceManager.rollback()` 精确回滚到快照点

## 替代方案

### 方案 A: git stash create + ref-to-ref diff（✅ 采用）

- 优点：轻量快照（不创建 commit）、ref-to-ref 避免并发干扰、回滚精确
- 缺点：依赖 git 命令行、非 git 仓库的项目无法使用

### 方案 B: 文件级快照（复制文件）

- 优点：不依赖 git、适用于任何项目类型
- 缺点：大项目复制成本高、diff 计算需要自建算法

### 方案 C: ref-to-working-tree diff

- 优点：实现简单，直接 `git diff HEAD`
- 缺点：其他 Agent 的变更会被误报为当前 Agent 的修改

## 后果

- **正面**：多 Agent 并发修改同一文件时，每个 Agent 的 Diff 独立计算，不会互相干扰
- **负面**：非 git 仓库的项目无法使用此机制（需要 fallback 到文件级检测）
- **中性**：冲突检测通过比较各 Agent 的 changedFiles Set 实现

## 代码依据

- `agent/WorkspaceManager.ts:70-80` — git stash create
- `agent/WorkspaceManager.ts:95-105` — branch fallback
- `agent/WorkspaceManager.ts:120+` — ref-to-ref diff
- `agent/WorkspaceManager.rollback()` — git stash apply

## 关联

- PRD: §4.4.1 Diff 可视化
- 技术文档: §4.7 产物预览与二次交互
