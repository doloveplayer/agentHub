# Phase 4: 产物预览与部署闭环 — 实现计划

> **合并自：** `2026-05-21-phase4b-prd-features.md`
>
> **关联 PRD：** `PRD.md` §4.4

**Goal:** 实现 Agent 产物的内联预览、编辑、二次交互，以及一键部署到三方平台。

**Architecture:** 按依赖关系分组执行：Diff 视图 → 产物预览 → 部署 → 扩展能力（测试/安全检查/代码审查）。每个功能独立可用。

---

## 执行状态总览

| Tier | 内容 | 状态 |
|------|------|------|
| Tier 0 | 代码 Diff 与版本历史 | ✅ 已实现 |
| Tier 1 | 产物预览（网页/文档/PPT/代码编辑） | ✅ 已实现 |
| Tier 2 | 部署编排（状态卡片 + 三方平台 + 回滚） | ✅ 已实现 |
| Tier 3 | 扩展能力（测试/安全检查/代码审查报告） | ✅ 已实现 |

---

## Tier 0: 代码 Diff 与版本历史 ✅

### 0.1 Diff 可视化

- [x] **Agent 执行前快照**：Agent/TaskAgent 启动前自动记录 workspace version；空沙箱会自动初始化 git baseline
  - 文件：`apps/api/src/agent/WorkspaceManager.ts` (已有 snapshot 方法)
- [x] **Diff 生成 API**：对比快照与当前文件，生成 diff 内容
  - 文件：新建 `apps/api/src/routes/diff.ts`
- [x] **Monaco DiffEditor**：并排对比视图，展开查看 hunk 内容
  - 文件：新建 `apps/web/src/components/DiffViewer.tsx`
- [x] **Diff 消息卡片（通知型）**：仅当有用户项目文件变更时推送；默认折叠显示摘要，展开后文件级 accept/reject；可关闭忽略
  - 文件：新建 `apps/web/src/components/DiffCard.tsx`
- [x] **Agent 内部文件过滤**：`_prompt_*`、`_env*`、`_inbox_*`、`_agent_*/`、`.claude/`、`.agenthub/` 等自动排除，不生成 diff
  - 文件：`apps/api/src/agent/WorkspaceManager.ts` (扩展 `isUserWorkspacePath`)
- [x] **沙箱 .gitignore 初始化**：`ensureGitRepo()` 时自动写入，防止 agent 内部文件被 git 追踪
  - 文件：`apps/api/src/agent/WorkspaceManager.ts`
- [x] **多 Agent 冲突高亮**：同一文件被多 Agent 修改时，冲突区域橙色标记，用户手动选择版本

### 0.2 版本历史

- [x] **版本节点记录**：每次 Agent 修改文件自动记录为一个版本（时间、Agent 名、修改摘要）
  - 文件：`apps/api/src/agent/WorkspaceManager.ts` (扩展)
- [x] **版本时间线 UI**：可视化展示版本链，点击查看详情
  - 文件：新建 `apps/web/src/components/VersionTimeline.tsx`
- [x] **版本间 Diff**：选择任意两个版本进行并排对比
- [x] **回退到历史版本**：一键回退到指定历史版本

---

## Tier 1: 产物预览 ✅

### 1.1 网页预览

- [x] **容器端口映射**：检测沙箱内 dev server 端口，Docker API 分配宿主机映射端口
  - 文件：`apps/api/src/agent/SandboxManager.ts` (新增 `portForward`)
- [x] **反向代理**：Nginx/Caddy 动态子域名 → 容器端口（当前实现为 `/preview/` 与 `/api/preview/.../proxy` 路由代理）
  - 文件：`docker/nginx.conf`
- [x] **iframe 内嵌预览**：右侧面板 Preview 标签页内嵌 iframe，不再常驻聊天区域底部
  - 文件：`apps/web/src/components/PreviewFrame.tsx` (简化) + `apps/web/src/components/AgentStatusPanel.tsx` (Preview 标签)
- [ ] **HMR 自动刷新**：Vite HMR WebSocket 通过反向代理链路（待后续实现）
- [x] **截图对比卡片**：手动截取修改前后页面，以对比卡片发送

### 1.2 文档渲染

- [x] **Markdown 渲染**：Agent 生成的 Markdown 在消息气泡内渲染（表格、代码高亮、图片）
  - 文件：`apps/web/src/components/MessageBubble.tsx` (扩展)
- [x] **文档段落引用**：选中文档段落 → "引用并交给 Agent" → 自动构建含上下文 prompt

### 1.3 PPT 浏览

- [x] **PPT/PPTX 内联浏览**：上传后在聊天窗口中翻页浏览、缩略图导航
  - 文件：新建 `apps/web/src/components/PPTViewer.tsx`
- [x] **PPT 导出**：支持导出为 PDF

### 1.4 代码编辑

- [x] **代码块内联编辑**：消息气泡中代码块使用 Monaco Editor 内联编辑
  - 文件：`apps/web/src/components/MessageBubble.tsx` (扩展)
- [x] **编辑后重交 Agent**："让 Agent 修改这段代码"按钮
- [x] **产物二次交互流程**：选中内容 → 引用 → Agent 增量处理 → 结果并排对比

---

## Tier 2: 部署编排 ✅

### 2.1 部署流程

- [x] **DevOpsAgent 生成部署配置**：Dockerfile + docker-compose.yml + 环境变量模板
- [x] **部署管道**：Build → Push → Deploy 实时日志推送
  - 文件：新建 `apps/api/src/routes/deploy.ts`
- [x] **多部署目标**：Vercel、Cloudflare Pages、自有 Docker 服务器
- [x] **WS 消息类型**：`deployment_status` (Server→Client), `deploy_to_platform` (Client→Server)

### 2.2 部署状态卡片

- [x] **实时进度**：消息气泡内嵌状态卡片（Building → Deploying → Success/Failed）
  - 文件：新建 `apps/web/src/components/DeployCard.tsx`
- [x] **完成卡片**：URL、构建时间、镜像 SHA

### 2.3 安全措施

- [x] **生产部署双重确认**：输入确认短语 + 点击确认按钮
- [x] **失败自动回滚**：`docker compose up -d --rollback`，Agent 汇报失败原因

---

## Tier 3: 扩展能力 ✅

> **优先级较低，可独立并行开发。**

### 3.1 测试生成与执行

- [x] **TestAgent 生成测试**：分析目标文件，编写测试代码
- [x] **测试执行**：沙箱中运行测试，收集结果（通过/失败/耗时）
  - 文件：新建 `apps/api/src/routes/test.ts`
- [x] **测试报告卡片**：用例列表 + 状态 + 耗时 + 失败堆栈
  - 文件：新建 `apps/web/src/components/TestReportCard.tsx`
- [x] **失败重试**："让 Agent 修复"按钮触发自动修复

### 3.2 依赖安全检查

- [x] **DepsAgent 执行 npm audit**：解析 JSON 输出，关联 CVE 编号
  - 文件：新建 `apps/api/src/routes/security.ts`
- [x] **安全检查卡片**：按严重程度分组（critical/high/moderate/low），CVE 链接
  - 文件：新建 `apps/web/src/components/SecurityCard.tsx`
- [x] **一键升级**：全部升级 / 逐个选择，实时日志推送

### 3.3 代码审查报告

- [x] **ReviewAgent 输出结构化报告**：分级（高危/警告/建议），文件:行号引用
- [x] **审查报告卡片**：点击问题跳转 Diff 视图对应行
  - 文件：新建 `apps/web/src/components/ReviewCard.tsx`
- [x] **逐条标记**："已修复" / "忽略"
- [x] **审查报告持久化**：可在消息历史中回看

---

## 修改文件清单

### Tier 0
| 文件 | 改动 |
|------|------|
| `apps/api/src/agent/WorkspaceManager.ts` | 扩展：getFileDiff, 版本记录, 文件过滤(isUserWorkspacePath), .gitignore 初始化 |
| `apps/api/src/ws/diffBroadcast.ts` | **新建** — Agent 完成后广播 diff/version/冲突 |
| `apps/api/src/routes/diff.ts` | **新建** — diff API（文件级 accept/reject；hunk 端点已移除） |
| `apps/web/src/components/DiffViewer.tsx` | **新建** — Monaco DiffEditor 并排对比 |
| `apps/web/src/components/DiffCard.tsx` | **新建** — 通知型 Diff 卡片（默认折叠、可关闭、文件级操作） |
| `apps/web/src/components/VersionTimeline.tsx` | **新建** — 版本时间线 |

### Tier 1
| 文件 | 改动 |
|------|------|
| `apps/api/src/agent/SandboxManager.ts` | 新增 portForward |
| `docker/nginx.conf` | 预览子域名代理配置 |
| `apps/api/src/routes/preview.ts` | **新建** — 端口检测、预览代理、截图 API |
| `apps/web/src/components/PreviewFrame.tsx` | **新建** — iframe 预览（简化，移除拖拽/pin，嵌于右侧面板 Preview 标签） |
| `apps/web/src/components/AgentStatusPanel.tsx` | 新增 Preview 标签页（Files/Agents/Tasks/Preview） |
| `apps/web/src/components/ScreenshotComparisonCard.tsx` | **新建** — 截图前后对比 |
| `apps/web/src/components/PPTViewer.tsx` | **新建** — PPT 浏览（内联卡片调用） |
| `apps/web/src/components/MessageInput.tsx` | 扩展：通用附件按钮（📎）、/deploy 命令拦截 |
| `apps/web/src/components/MessageBubble.tsx` | 扩展：Markdown 渲染、代码内联编辑、段落引用 |
| `apps/web/src/components/ChatView.tsx` | 移除底部工具栏（PreviewFrame、PPTViewer、DeploymentLauncher 不再常驻） |

### Tier 2
| 文件 | 改动 |
|------|------|
| `apps/api/src/routes/deploy.ts` | **新建** — 部署 API |
| `apps/web/src/components/DeployCard.tsx` | **新建** — 部署状态卡片（内联消息流） |
| `apps/web/src/components/MessageInput.tsx` | /deploy 命令拦截，触发部署 API |
| `apps/web/src/hooks/useChat.ts` | deployment_status 事件处理 |
| `packages/shared/src/types.ts` | deployment_status 消息类型 |

> **交互方式变更**：部署由 `/deploy <target>` 命令触发（遵循 IM 聊天范式），`DeploymentLauncher.tsx` 已废弃，不再使用常驻工具栏控件。

### Tier 3
| 文件 | 改动 |
|------|------|
| `apps/api/src/routes/test.ts` | **新建** — 测试执行 API |
| `apps/api/src/routes/security.ts` | **新建** — 安全检查 API |
| `apps/api/src/routes/review.ts` | **新建** — 审查报告结构化 API |
| `apps/api/src/artifacts/ArtifactTools.ts` | **新建** — 部署配置、测试/audit/review 解析 |
| `apps/web/src/components/TestReportCard.tsx` | **新建** — 测试报告卡片 |
| `apps/web/src/components/SecurityCard.tsx` | **新建** — 安全检查卡片 |
| `apps/web/src/components/ReviewCard.tsx` | **新建** — 审查报告卡片 |

---

## 验证方案

1. **Diff**：Agent 仅修改内部文件时 → 不显示 diff 卡片；Agent 修改用户项目文件时 → 通知型卡片默认折叠，展开后 Monaco 并排对比，文件级 accept/reject 可选，关闭按钮忽略
2. **网页预览**：Agent 启动 dev server → 右侧面板 Preview 标签页打开 iframe → 手动截图对比
3. **文档渲染**：Agent 输出 Markdown → 消息气泡内表格/代码块正确渲染 → 段落引用 → Agent 增量修改
4. **PPT 浏览**：上传 PPTX → 聊天窗口内翻页浏览 → 导出 PDF
5. **代码编辑**：代码块内联编辑 → 交给 Agent 修改 → 结果展示
6. **部署**：输入 `/deploy docker` → DeployCard 内联展示 Building → Deploying → Success（含 URL）
7. **测试报告**：TestAgent 执行 → 报告卡片展示用例状态 → 失败重试
8. **安全检查**：npm audit → CVE 分组卡片 → 一键升级
9. **审查报告**：ReviewAgent 输出 → 分级卡片 → 点击跳转 Diff 行
