# 缺陷清单

本轮发现缺陷 10 个，其中 8 个已修复并回归，2 个仍为未修复/待确认风险。未将普通阻塞/未执行用例计入缺陷。

## BUG-001

缺陷编号： BUG-001  
关联用例： TC-SESS-012  
缺陷标题： 空白字符串消息被后端接受并写入 DB  
严重级别： 严重  
优先级： 高  
所属模块： 会话与消息  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-SESS-012 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： 会话与消息 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： 后端 `/api/chat/send` content 只校验 `min(1)`，未校验 trim 后非空；改为 trim 后非空 refine。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-002

缺陷编号： BUG-002  
关联用例： TC-AGT-008  
缺陷标题： 软删除 Agent 仍可被指定绑定到 group session  
严重级别： 严重  
优先级： 高  
所属模块： Agent 管理  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-AGT-008 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： Agent 管理 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： 创建会话时未校验 agentIds 的 active 状态；新增 active agent 校验。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-003

缺陷编号： BUG-003  
关联用例： TC-AUTH-004  
缺陷标题： GitHub token 交换失败路径可能长时间挂起且错误状态不明确  
严重级别： 一般  
优先级： 中  
所属模块： 认证  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-AUTH-004 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： 认证 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： OAuth callback 对 GitHub fetch 无超时；新增 10s 超时并将无 token 响应改为 401。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-004

缺陷编号： BUG-004  
关联用例： TC-OPS-004  
缺陷标题： 非法部署目标被默认映射为 docker 并可能触发部署  
严重级别： 严重  
优先级： 高  
所属模块： 部署  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-OPS-004 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： 部署 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： REST/WS 使用 normalizeTarget 静默兜底；新增显式 target 校验，前端显示错误消息。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-005

缺陷编号： BUG-005  
关联用例： TC-AGT-028  
缺陷标题： solo 会话输入 @ 仍弹出 Agent mention 面板  
严重级别： 一般  
优先级： 中  
所属模块： 前端 UI  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-AGT-028 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： 前端 UI 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： MessageInput 未根据 active session type 限制 mention；仅 group session 展示 popup。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-006

缺陷编号： BUG-006  
关联用例： TC-SESS-006  
缺陷标题： 会话列表 lastMessage 未按约定截断  
严重级别： 一般  
优先级： 中  
所属模块： 会话列表  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-SESS-006 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： 会话列表 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： GET /api/sessions 直接返回完整 lastMessage；新增 80 字符裁剪。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-007

缺陷编号： BUG-007  
关联用例： TC-SBX-013 / TC-AGT-009  
缺陷标题： 同一 Agent 第二次调用因 message-scoped CLAUDE_CONFIG_DIR 导致 Claude --resume 立即失败  
严重级别： 严重  
优先级： 高  
所属模块： Agent Provider  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-SBX-013 / TC-AGT-009 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： Agent Provider 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： 一条消息一个 `_agent_${messageId}` 配置目录，但 resume session 按 Agent 复用；新增 agentConfigId，使 prompt/container 仍按消息唯一，Claude 配置目录按 Agent 稳定。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-008

缺陷编号： BUG-008  
关联用例： TC-SESS-020 / LIVE-READ  
缺陷标题： stream_end 早于 DB 内容更新，结束后立即查询可能读到空 agent 消息  
严重级别： 一般  
优先级： 中  
所属模块： WebSocket / 消息一致性  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-SESS-020 / LIVE-READ 的预期。  
实际结果： 修复前不符合预期；修复后复现脚本通过。  
复现概率： 必现  
影响范围： WebSocket / 消息一致性 相关主流程、权限或用户体验。  
截图或日志： `/tmp/agenthub_bug_repros.ts` 输出；最终回归无失败输出。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： done 分支 fire-and-forget 更新 DB 后立即广播 stream_end；改为等待 DB update 完成后再广播 stream_end，并用真实 Agent 脚本回归。  
修复状态： 已修复 / 已回归  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 通过  
修复建议： 保留回归脚本或迁移为正式集成测试。

## BUG-009

缺陷编号： BUG-009  
关联用例： TC-WS-010 / TC-WS-011 / TC-NFR-006  
缺陷标题： Trust OFF 写文件任务未产生可响应的 permission_request 事件  
严重级别： 严重  
优先级： 高  
所属模块： 权限代理  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-WS-010 / TC-WS-011 / TC-NFR-006 的预期。  
实际结果： 新增默认关闭的 `AGENTHUB_AGENT_PROVIDER=test` 后，权限请求、允许、拒绝、UI 权限卡片和 3 秒内展示均已通过回归；真实 Claude Code `--print` provider 仍未产生可响应 permission_request，作为 provider 风险保留。  
复现概率： test provider 路径已回归通过；真实 Claude Code `--print` 路径仍必现不产生可响应权限事件。  
影响范围： 权限代理测试可自动化回归；真实模型 provider 的交互式权限仍需架构处理。  
截图或日志： `docs/superpowers/reports/mock-provider-ws-evidence.json`、`docs/superpowers/reports/mock-provider-ui-evidence.json`、`docs/superpowers/reports/mock-provider-ui-permission.png`、`docs/superpowers/reports/live-agent-evidence.json`。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： Claude Code `--print`/stream-json 当前表现为工具结果错误和文本确认提示，没有可拦截 permission_request；本轮通过 test provider 建立可控权限事件通道，用于产品 UI/WS/DB 自动化回归。  
修复状态： 测试模式已修复 / 已回归；真实 Claude provider 风险未修复  
修复方式： 新增 `TestAgentProcess`、`TestAgentProvider`、`processFactory`，以环境变量切换，默认仍使用真实 Claude。  
Code Review 结果： 通过，真实 provider 风险需继续处理  
修复建议： 保留 test provider 作为确定性回归；真实 provider 需继续评估 PTY/remote-control 或非 `--print` 权限通道。

## BUG-010

缺陷编号： BUG-010  
关联用例： TC-SBX-008  
缺陷标题： Agent 可在工作区读取 provider 环境文件，服务日志也可能出现工具结果中的凭据内容  
严重级别： 严重  
优先级： 高  
所属模块： 沙箱 / 日志安全  
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器  
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试  
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-SBX-008 的预期。  
实际结果： 当前仍不符合预期，已作为未修复/待确认风险保留。  
复现概率： 必现  
影响范围： 沙箱 / 日志安全 相关主流程、权限或用户体验。  
截图或日志： `docs/superpowers/reports/live-agent-evidence.json`、API 日志和风险报告。  
接口信息： 见关联用例和 testcase-results.md。  
初步分析： 真实 Agent 读取项目结构时读取到 `_env.sh`；报告不记录具体值。建议改为 Docker env 注入、日志脱敏，并避免把凭据文件写入 /workspace。  
修复状态： 未修复 / 风险接受待确认  
修复方式： 见 fix-and-review-report.md。  
Code Review 结果： 未通过 / 需继续处理  
修复建议： 需要产品/架构确认后继续修复；上线前不得忽略该风险。
