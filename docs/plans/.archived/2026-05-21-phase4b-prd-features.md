# Phase 4b — PRD §4.4 全流程开发增强 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.
> **Parent Doc:** `PRD.md` §4.4

**Goal:** 实现 Diff 可视化、网页预览、代码审查、测试生成、依赖安全检查、一键部署六个独立功能，形成从编码到部署的闭环。

**Architecture:** 按 PRD 执行顺序分组：Diff → 代码审查 → 网页预览 → 一键部署（串行链）；测试生成 + 依赖检查（独立并行）。每个功能独立可用，不设严格时间线。

**Tech Stack:** Monaco Editor (Diff), Nginx/Caddy (reverse proxy), Docker (build/deploy)

**Dependencies:** Phase 4a (多厂商适配) 完成

---

## PRD §4.4 需求逐项对照

| PRD 行号 | 需求 | 对应 Task |
|----------|------|-----------|
| 400-406 | Diff 可视化：快照 + Monaco DiffEditor + 逐行 accept/reject + 冲突高亮 + 消息卡片 | Task 1 |
| 409-420 | 网页预览：端口映射 + 反向代理 + iframe + 子域名 + 拖拽高度 + HMR | Task 3 |
| 424-434 | 代码审查：分级报告卡片 + 点击跳转 Diff 行 + 逐条标记 + 持久化 | Task 2 |
| 438-447 | 测试生成：TestAgent + 执行收集 + 报告卡片 + 失败重试 | Task 4 |
| 451-461 | 依赖安全：DepsAgent + CVE 关联 + 过期版本 + 一键升级 | Task 5 |
| 465-476 | 一键部署：Docker build 日志 + 多环境 + 双重确认 + 回滚 | Task 6 |

---

## Task 1: Diff 可视化 (PRD §4.4.1)

**Files:**
- Create: `apps/web/src/components/DiffViewer.tsx`
- Create: `apps/web/src/components/DiffCard.tsx`
- Modify: `apps/api/src/agent/WorkspaceManager.ts` (from Phase 3.5)

### Step 1: 后端 Diff 生成 API

复用 Phase 3.5 的 `WorkspaceManager.getChangedFiles()`，新增 diff 内容获取：

```typescript
// apps/api/src/routes/diff.ts
import { Hono } from 'hono';
import { WorkspaceManager } from '../agent/WorkspaceManager.js';

const diff = new Hono();

// GET /api/diff/:sessionId/stat — file change list
diff.get('/:sessionId/stat', async (c) => {
  const snapshot = getSnapshotForSession(c.req.param('sessionId'));
  const files = WorkspaceManager.getChangedFiles(snapshot);
  return c.json({ files });
});

// GET /api/diff/:sessionId/file?path=... — per-file diff
diff.get('/:sessionId/file', async (c) => {
  const snapshot = getSnapshotForSession(c.req.param('sessionId'));
  const filePath = c.req.query('path');
  const diff = WorkspaceManager.getFileDiff(snapshot, filePath);
  return c.json({ diff });
});

// POST /api/diff/:sessionId/accept — accept a file's changes
// POST /api/diff/:sessionId/reject — revert a file to snapshot
```

### Step 2: 前端 Monaco DiffEditor

```tsx
// apps/web/src/components/DiffViewer.tsx
import { DiffEditor } from '@monaco-editor/react';
import { useState } from 'react';

interface Props {
  original: string;
  modified: string;
  fileName: string;
  onAccept?: () => void;
  onReject?: () => void;
}

export function DiffViewer({ original, modified, fileName, onAccept, onReject }: Props) {
  const [conflictZones, setConflictZones] = useState<{ start: number; end: number; agent: string }[]>([]);

  return (
    <div className="h-96 border border-slate-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800 border-b border-slate-700">
        <span className="text-xs font-mono text-slate-300">{fileName}</span>
        <div className="flex gap-1">
          {onAccept && (
            <button onClick={onAccept} className="px-2 py-0.5 bg-green-700 text-white text-xs rounded">Accept</button>
          )}
          {onReject && (
            <button onClick={onReject} className="px-2 py-0.5 bg-red-700 text-white text-xs rounded">Reject</button>
          )}
        </div>
      </div>
      <DiffEditor
        original={original}
        modified={modified}
        language="typescript"
        theme="vs-dark"
        options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false } }}
      />
    </div>
  );
}
```

### Step 3: DiffCard 消息气泡

Agent 完成后自动在聊天流中插入 DiffCard，展示文件变更清单。点击文件名展开 DiffViewer。

---

## Task 2: 代码审查 (PRD §4.4.3)

**Files:**
- Create: `apps/web/src/components/ReviewCard.tsx`

### Step 1: 审查报告分级卡片

ReviewAgent 输出结构化审查报告。后端解析后生成分级卡片，前端渲染：

```tsx
interface ReviewIssue {
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  file: string;
  line: number;
  suggestion: string;
  status: 'open' | 'fixed' | 'ignored';
}

// Severity icons and colors
const SEVERITY_CONFIG = {
  high:   { icon: '🔴', bg: 'bg-red-950/30', border: 'border-red-700/50', text: 'text-red-300' },
  medium: { icon: '🟡', bg: 'bg-amber-950/30', border: 'border-amber-700/50', text: 'text-amber-300' },
  low:    { icon: '🟢', bg: 'bg-green-950/30', border: 'border-green-700/50', text: 'text-green-300' },
};
```

### Step 2: 交互功能

- 点击问题行 → 右侧面板跳转到 DiffViewer 对应行（用 Monaco `revealLine(lineNumber)`）
- 逐条标记 "已修复" / "忽略"
- 审查报告持久化到 DB（`ReviewReport` 表或消息 JSON metadata）

---

## Task 3: 网页预览 (PRD §4.4.2)

**Files:**
- Create: `apps/web/src/components/PreviewFrame.tsx`
- Modify: 前端 ChatView 布局（底部可拖拽 iframe）

### Step 1: 容器端口映射

Agent 在沙箱内启动 dev server 后，检测监听端口（如 3000）。后端通过 Docker API 获取容器 IP，分配宿主机随机端口做端口转发：

```typescript
// SandboxManager.portForward(containerId, containerPort) → hostPort
static async portForward(containerId: string, containerPort: number): Promise<number> {
  // docker exec + iptables 或 docker network connect 实现端口映射
  // 或直接通过 Docker API 获取容器 IP，前端直连
}
```

### Step 2: 反向代理

Nginx/Caddy 配置动态子域名 `preview-{sessionId}.agenthub.internal` → 代理到容器端口。开发阶段简化：直接用容器 IP:Port，前端 iframe 嵌入。

### Step 3: 前端 iframe 嵌入

```tsx
// apps/web/src/components/PreviewFrame.tsx
export function PreviewFrame({ url }: { url: string }) {
  const [height, setHeight] = useState(400);
  return (
    <div className="border-t border-slate-700" style={{ height }}>
      <div className="flex items-center justify-between px-3 py-1 bg-slate-800 border-b border-slate-700"
        onMouseDown={(e) => { /* drag resize logic */ }}>
        <span className="text-xs text-slate-400">Preview · {url}</span>
        <button className="text-xs text-slate-500">✕</button>
      </div>
      <iframe src={url} className="w-full h-full" />
    </div>
  );
}
```

---

## Task 4: 测试生成与执行 (PRD §4.4.4)

**Files:**
- Create: `apps/web/src/components/TestReportCard.tsx`

### Step 1: TestAgent + 后端测试执行 API

TestAgent 在沙箱中执行 `npm test` 或对应框架命令。后端捕获结果（stdout + exit code），解析为结构化报告。

```typescript
// apps/api/src/routes/test.ts
// POST /api/test/:sessionId/run — execute tests, return report
interface TestReport {
  total: number;
  passed: number;
  failed: number;
  duration: string;
  cases: {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    duration: string;
    error?: string;
    stack?: string;
  }[];
}
```

### Step 2: 前端测试报告卡片

渲染用例列表 + 状态 + 耗时。失败用例附带堆栈，"让 Agent 修复"按钮触发重试。

---

## Task 5: 依赖与安全检查 (PRD §4.4.5)

**Files:**
- Create: `apps/web/src/components/SecurityCard.tsx`

### Step 1: DepsAgent + npm audit 执行

DepsAgent 在沙箱中执行 `npm audit --json`。后端解析 JSON 输出，关联 CVE 编号。

```typescript
// Parsed npm audit output
interface VulnerabilityReport {
  packages: {
    name: string;
    currentVersion: string;
    latestVersion?: string;
    severity: 'critical' | 'high' | 'moderate' | 'low';
    cve?: string;
    recommendation: string;
  }[];
  summary: { critical: number; high: number; moderate: number; low: number };
}
```

### Step 2: 前端安全检查卡片

- 按严重程度分组（🔴高危 / 🟡警告 / 🟢低危）
- CVE 编号可点击跳转 NVD 详情
- "一键升级"按钮 → 触发 `npm update`，或逐个选择升级

---

## Task 6: 一键部署 (PRD §4.4.6)

**Files:**
- Create: `apps/api/src/routes/deploy.ts`
- Create: `apps/web/src/components/DeployCard.tsx`

### Step 1: DevOpsAgent 生成 Dockerfile

DevOpsAgent 分析项目 → 生成 Dockerfile + docker-compose.yml + 环境变量模板。

### Step 2: 部署流程编排

```typescript
// apps/api/src/routes/deploy.ts
// POST /api/deploy/:sessionId/start — start deployment pipeline
async function deploy(sessionId: string, env: 'dev' | 'test' | 'prod') {
  // 1. Build: docker build -t agenthub-deploy-{sessionId}:latest .
  // 2. Push: docker tag + docker push (prod only)
  // 3. Deploy: docker compose up -d
  // Real-time logs pushed via WebSocket
  // Prod: double confirmation required
}
```

### Step 3: 双重确认（生产环境）

生产部署前弹出确认对话框：
```
⚠️ 生产环境部署确认
请在下方输入 "CONFIRM DEPLOY TO PRODUCTION" 以确认：
[________________]
[确认部署] [取消]
```

### Step 4: 部署卡片

- 部署完成卡片：URL、构建时间、镜像 SHA
- 失败自动回滚到上一个成功镜像（`docker compose up -d --rollback`）
- Agent 汇报失败原因

---

## 文件结构总览

```
apps/api/src/
  routes/
    diff.ts          # Task 1: diff API
    review.ts        # Task 2: review report API (or WS-based)
    preview.ts       # Task 3: port forward + proxy
    test.ts          # Task 4: test execution
    security.ts      # Task 5: npm audit
    deploy.ts        # Task 6: deployment pipeline
  agent/
    WorkspaceManager.ts  # [extend] getFileDiff, getSnapshotForSession

apps/web/src/
  components/
    DiffViewer.tsx       # Task 1: Monaco DiffEditor
    DiffCard.tsx         # Task 1: chat bubble wrapper
    ReviewCard.tsx       # Task 2: review report card
    PreviewFrame.tsx     # Task 3: iframe embed
    TestReportCard.tsx   # Task 4: test results
    SecurityCard.tsx     # Task 5: vulnerability report
    DeployCard.tsx       # Task 6: deployment pipeline card
```

---

## Verification

- [ ] Diff 卡片在 Agent 完成后自动出现在消息流中
- [ ] Monaco DiffEditor 渲染并排对比，逐行 accept/reject 可用
- [ ] 审查卡片的 severity 分级正确，点击跳转到 Diff 行
- [ ] 网页预览 iframe 在聊天窗口底部可拖拽调整高度
- [ ] 测试报告卡片展示通过/失败/错误详情
- [ ] 安全检查卡片按 CVE 严重程度分组，一键升级可用
- [ ] 生产部署需要输入确认短语后才执行
- [ ] 部署失败后自动回滚 + Agent 汇报原因
