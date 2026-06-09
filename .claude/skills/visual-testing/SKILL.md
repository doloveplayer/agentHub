---
name: visual-testing
description: AgentHub 可视化测试。使用截图 + 图像分析 MCP 工具验证 UI 功能和外观。当需要测试前端功能、审查 UI 变更、对比设计稿、确认页面渲染正确时使用。也适用于用户说"截图看看"、"测试一下 UI"、"看看页面"、"前端测试"等场景。不要用纯文字描述来验证视觉效果——截图才靠谱。
---

# AgentHub 可视化测试

UI 功能和外观必须通过截图验证，不能仅靠代码推断。文字描述无法替代视觉确认。

## 前置条件

确保服务已启动：

```bash
# 后端
cd apps/api && npx tsx src/index.ts

# 前端
cd apps/web && npx vite
```

## 测试流程

### Step 1: 启动浏览器并截图

使用 Playwright 技能（`document-skills:webapp-testing`）进行浏览器自动化：

1. 打开目标页面
2. 等待页面加载完成
3. 截图保存至 `screenTmp/AgentScreenshots/`

截图命名规范：`{功能}-{场景}-{状态}.png`
- `login-page-default.png` — 登录页默认状态
- `chat-send-message.png` — 发送消息后的聊天界面
- `sidebar-session-list.png` — 侧边栏会话列表

### Step 2: 图像分析

使用 MCP 图像分析工具验证截图：

**通用分析** — `analyze_image`：
```
image_source: "screenTmp/AgentScreenshots/xxx.png"
prompt: "检查页面是否正确渲染，布局是否合理，是否有明显的 UI 错误"
```

**UI 对比** — `ui_diff_check`：
```
expected_image_source: "设计稿或参考截图路径"
actual_image_source: "实际截图路径"
prompt: "对比两个截图的布局、颜色、字体差异"
```

### Step 3: 功能验证清单

对于每个 UI 功能，验证以下维度：

**布局**
- 元素位置是否正确（对齐、间距）
- 响应式布局在不同窗口尺寸下是否正常
- 是否有元素溢出或被裁剪

**交互**
- 点击按钮是否有预期反馈
- 表单输入和提交是否正常
- 状态变化（loading、error、success）是否正确显示

**内容**
- 文本是否正确显示（无乱码、无截断）
- 图标和图片是否加载
- 动态数据是否正确渲染

**样式**
- 颜色是否与设计一致
- 字体和字号是否正确
- 暗色/亮色主题切换是否正常

### Step 4: 记录结果

测试结果格式：

```
## 可视化测试结果

**测试功能**：[功能名]
**测试时间**：[时间戳]

### 通过项
- [x] 登录页布局正确
- [x] 表单交互正常

### 问题项
- [ ] [截图] 侧边栏会话列表文字截断 → 需要调整容器宽度

### 截图
- `screenTmp/AgentScreenshots/login-default.png`
- `screenTmp/AgentScreenshots/login-error.png`
```

## E2E 测试（绕过认证）

自动化测试通过 dev-token 绕过密码认证：

```bash
# 获取 dev-token（仅 NODE_ENV=development 可用）
TOKEN=$(curl -s http://localhost:3000/api/auth/dev-token | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

# 在 Playwright 中注入 token
# localStorage.setItem('agenthub_token', token)
# 然后刷新页面
```

## TypeScript 编译检查

UI 改动后，同步运行类型检查确保没有引入类型错误：

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

如果改动涉及后端 API 调用：

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

## 常见问题

**截图是空白的**：页面可能还没加载完成，增加等待时间或使用 `waitForSelector`。

**元素找不到**：检查选择器是否正确，页面是否在 iframe 中。

**样式不一致**：确认 CSS 是否被缓存，尝试硬刷新。
