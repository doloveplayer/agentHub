# ADR-009: 沙箱挂载三分区策略

## 状态

已接受

## 背景

每个 Session 的 Docker 沙箱需要同时承载三种不同生命周期的数据：会话运行时、用户工作区、Agent 持久化身份。

## 决策

1. **三分区挂载**：
   - `/sandbox` → `.sandboxes/{sessionId}/`（会话级，plan.json、agent 配置、inbox）
   - `/workspace` → 用户指定或默认路径（用户级，代码、文件）
   - `/home/agents` → `.agents/`（全局永久，CLAUDE.md、memory、skills）
2. **Solo/Group 差异化内存**：Solo 512MB / Group 2048MB
3. **环境变量纯白名单**：`SAFE_ENV_PREFIXES`（ANTHROPIC_/CLAUDE_/PATH/HOME/NVM_/LANG/LC_/TERM/COLOR/TZ/DEBIAN_FRONTEND）
4. **自定义工作目录**：`customHostWorkDir` 支持用户指定宿主机任意目录

## 替代方案

### 方案 A: 三分区挂载 + 白名单环境变量（✅ 采用）

- 优点：三种生命周期清晰分离、白名单防止敏感信息泄露
- 缺点：Docker bind mount 不可变——workspace 路径变更需重建容器

### 方案 B: 单挂载点（全部映射到 /workspace）

- 优点：挂载配置简单
- 缺点：会话运行时和用户文件混在一起、Agent 持久化数据随 session 销毁

### 方案 C: Docker Volume（而非 bind mount）

- 优点：Docker 管理生命周期、支持 volume driver
- 缺点：用户无法直接在宿主机访问文件、调试不便

## 后果

- **正面**：Agent 持久化身份跨 Session 共享；环境变量白名单防止 DATABASE_URL 等泄露
- **负面**：容器 bind mount 不可变——workspace 路径变更需重建容器
- **中性**：Solo/Group 差异化内存需要在 session 创建时确定类型

## 代码依据

- `agent/SandboxManager.ts:55-62` — 三分区 binds
- `ws/state.ts:226` — Solo/Group 内存配置
- `agent/ClaudeCodeProcess.ts:10-22` — SAFE_ENV_PREFIXES 白名单

## 关联

- PRD: §4.1 简易沙箱环境
- 技术文档: §4.8 沙箱隔离
- ADR: 001（Multi-Agent Architecture，沙箱是其核心组件）
