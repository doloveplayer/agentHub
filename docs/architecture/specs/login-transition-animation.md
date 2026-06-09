# 登录过渡动画 Spec

## 概述

登录成功后，背景标语文字执行收拢→液体融合→扩展反转→显现工作区的过渡动画，总时长约 2.3s。

## 当前状态

登录页面已具备：
- 球面分布的 18 条标语（`SLOGANS` 数组）
- 鼠标追随 spotlight 揭示效果
- 点击登录后直接跳转（无动画）

动画功能已从代码中移除，待后续按此 spec 重新开发。

---

## 动画分四个阶段

### Phase 1：弧线收拢（1.1s）

**行为**：
- 登录成功后，登录表单立即隐藏
- 背景 18 条标语的**每个字**从初始位置沿弧线飞向登录按钮中心点（50%, 53%）
- 远处的字先启动（按距离反比延迟），近处的字后启动 → 形成层次感
- 路径为弧线而非直线：`sin(t * π)` 产生垂直于连线方向的偏移
- 接近中心时文字逐渐 `blur` 模糊 → 液体融合前兆
- 同一句话的字间距压缩（约为字宽的 60%），保持紧凑

**关键参数**：
- 时长：1100ms
- 缓动：`easeOutQuart`（先快后慢，收拢有冲击感）
- 弧线偏移：`sin(lt * π) * curve * (1 - lt)`，curve 为 ±30px 随机值
- 模糊：`lt > 0.6` 时开始 blur，最大 3.2px

### Phase 2：液体融合（0.5s）

**行为**：
- 所有字消失（opacity: 0）
- 中心出现光团，执行 3 次脉动膨胀（`sin(t * π * 3)`）
- 光团为椭圆形，多层径向渐变：中心全亮 → 30% 处 80% 透明 → 50% 处半透明 → 70% 处消失
- blur 从 20px 逐渐减小到 10px → 从模糊凝聚为清晰
- 整体 scale 随脉动微调（0.85 ~ 1.15）

**关键参数**：
- 时长：500ms
- 缓动：`easeInOutCubic`
- 光团大小：12vw → 30vw（随脉动）
- 颜色：`rgba(56,189,248,1)` → `rgba(99,179,237,0.5)` → transparent

### Phase 3：扩展反转（0.4s）

**行为**：
- 光团从中心扩展为全屏覆盖
- 径向渐变反转：从「中心亮/边缘暗」过渡到「中心暗/边缘亮」
- 渐变中心点在 (50%, 53%)，与登录按钮对齐

**关键参数**：
- 时长：400ms
- 缓动：`easeInOutCubic`
- 中心色：`rgba(56,189,248, alpha)` 从 0.8 衰减到 0
- 边缘色：`rgba(15,23,42, alpha)` 从 0.6 增长到 1.0

### Phase 4：暗中显现（0.3s）

**行为**：
- 工作区（ChatPage）在 z-index 25 层渲染，初始 opacity: 0
- 光晕层（z-25）opacity 从 1→0
- 工作区 opacity 从 0→1
- 黑色遮罩（z-30）opacity 从 1→0
- 动画结束后 `navigate('/')`

**关键参数**：
- 时长：300ms
- 缓动：`easeInOutCubic`
- 导航延迟：动画结束后 300ms

---

## 技术实现要点

### 字级拆分
每条标语 `split('')` 拆为单字，每个字为独立 DOM 元素（`.char-item`），拥有：
- `data-sx` / `data-sy`：初始视口坐标（px）
- `will-change: transform, opacity, filter`

### 位置计算
- 登录按钮中心：`BTN_CX = 50%`, `BTN_CY = 53%`（视口百分比）
- 字的初始位置：`SLOGANS.x/y` + 字索引 * 字宽偏移
- 字宽参考：`text-4xl: 36px, text-5xl: 48px, text-6xl: 60px, text-7xl: 72px`

### 动画驱动
- 使用 `requestAnimationFrame` 循环，不用 CSS animation
- 直接操作 DOM `style.transform / opacity / filter`
- Phase 状态机：`converge → liquid → expand → reveal`

### 层级结构（z-index）
```
z-0   点阵背景
z-1   静态标语（dim 层，opacity 0.025）
z-2   spotlight 揭示层（鼠标追随遮罩）
z-20  动画字层（.char-item 容器）
z-25  光晕层 / 工作区层
z-30  黑色遮罩层
z-10  登录表单（!animating 时显示）
```

### 登录状态处理
- `setAnimating(true)` 必须在 `await login()` **之前**调用
- 原因：`login()` 内部 `setToken()` 会立即触发 `isLoggedIn = true`，如果 `animating` 未设置，组件会走 `<Navigate to="/" />` 跳过动画
- `if (isLoggedIn && !animating) return <Navigate to="/" />`

---

## 需要的依赖

无额外依赖。纯 `requestAnimationFrame` + CSS `transform/filter` 实现。

## 文件

- `apps/web/src/components/LoginPage.tsx` — 主文件，包含动画逻辑
- `apps/web/src/hooks/useMousePosition.ts` — 鼠标位置追踪（spotlight 效果）
- `apps/web/src/pages/ChatPage.tsx` — 工作区页面（Phase 4 渲染）
