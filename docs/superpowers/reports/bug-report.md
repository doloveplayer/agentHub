# 缺陷清单

本轮发现缺陷 14 个，14 个均已修复并回归。未将普通阻塞/未执行用例计入缺陷。

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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
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
关联用例： TC-WS-010 / TC-WS-011 / TC-WS-012 / TC-WS-013 / TC-NFR-006
缺陷标题： Trust OFF 写文件任务未产生可响应的 permission_request 事件
严重级别： 严重
优先级： 高
所属模块： 权限代理
测试环境： Chromium Playwright、本地 API 3000、本地 Web 5173、PostgreSQL/Redis/Docker 本地容器
发现方式： Playwright 页面测试 / 接口测试 / 数据库验证 / 回归测试
前置条件： 本地服务启动，测试用户 token 有效

复现步骤：
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-WS-010 / TC-WS-011 / TC-WS-012 / TC-WS-013 / TC-NFR-006 的预期。
实际结果： 新增默认关闭的 `AGENTHUB_AGENT_PROVIDER=test` 后，权限请求、允许、拒绝、UI 权限卡片和 3 秒内展示均已通过回归；真实 Claude provider 也已通过 Allow/Deny/Timeout 三态和 Playwright UI 权限卡回归。
复现概率： 修复后未复现；test provider 路径和真实 Claude provider 路径均已通过。
影响范围： 权限代理测试可自动化回归；真实模型 provider 权限请求链路已有实测证据。
截图或日志： `docs/superpowers/reports/evidence/mock-provider-ws-evidence.json`、`docs/superpowers/reports/evidence/mock-provider-ui-evidence.json`、`docs/superpowers/reports/evidence/mock-provider-ui-permission.png`、`docs/superpowers/reports/evidence/real-provider-permission-evidence.json`、`docs/superpowers/reports/evidence/real-provider-ui-evidence.json`、`docs/superpowers/reports/evidence/real-provider-ui-permission.png`。
接口信息： 见关联用例和 testcase-results.md。
初步分析： Claude Code `--print`/stream-json 不保持原进程交互式等待权限输入；修复后在 Trust OFF 下拦截 mutating `tool_use`，先生成 `permission_request`，Allow 通过 `--allowedTools <tool>` replay，Deny/Timeout 直接结束。
修复状态： 已修复 / 已回归
修复方式： 新增 test provider 做确定性回归；真实 `ClaudeCodeProcess` 增加 mutating tool permission proxy、Allow replay、Deny/Timeout 结束路径和单元测试。
Code Review 结果： 通过
修复建议： 保留 test provider 作为低成本确定性回归；真实 provider 路径定期执行三态 smoke 测试。

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
1. BUG-001~BUG-006 运行 `npx tsx /tmp/agenthub_bug_repros.ts`；BUG-007~BUG-010 运行 `npx tsx /tmp/agenthub_live_agent_tests.ts` 并结合 `evidence/stream-db-consistency-evidence.json`。
2. 按关联用例构造真实 API/WS/页面输入。
3. 观察断言失败、接口/页面实际行为、DB 状态和 WS 事件。

预期结果： 符合 TC-SBX-008 的预期。
实际结果： 修复后 workspace 不再生成 `_env.sh`，真实 provider Allow/Deny/Timeout/UI 证据均显示 `envFileExists=false`；单元测试确认 Docker args 仅包含 env name，不包含测试 token 明文。
复现概率： 修复后未复现
影响范围： 沙箱 / 日志安全 相关主流程、权限或用户体验。
截图或日志： `docs/superpowers/reports/evidence/real-provider-permission-evidence.json`、`docs/superpowers/reports/evidence/real-provider-ui-evidence.json`、`apps/api/src/agent/ClaudeCodeProcess.test.ts`。
接口信息： 见关联用例和 testcase-results.md。
初步分析： 真实 Agent 读取项目结构时读取到 `_env.sh`；报告不记录具体值。已改为 Docker env name 注入、日志脱敏，并避免把凭据文件写入 `/workspace`。
修复状态： 已修复 / 已回归
修复方式： `ClaudeCodeProcess` 不再写 workspace env 文件，`buildDockerEnvArgs` 仅传递允许的 env name，日志只输出 auth 有无；单元测试覆盖不写 `_env.sh` 和 docker args 不含 secret 明文。
Code Review 结果： 通过
修复建议： 后续如开放 Agent 任意执行 `env`/Bash，继续评估凭据代理、短期令牌或更强沙箱隔离。

## BUG-011

缺陷编号： BUG-011
关联用例： TC-HUB-010 / TC-HUB-011 / TC-HUB-028 / TC-HUB-029
缺陷标题： Planner DAG 调度未等待跨 Agent 依赖且前端提前将全部任务置 running
严重级别： 严重
优先级： 高
所属模块： Planner DAG / WebSocket 调度 / 前端 TaskDAG
测试环境： `AGENTHUB_AGENT_PROVIDER=test`、本地 API/Web、PostgreSQL/Redis/Docker
发现方式： 代码审查 + WS DAG 自动化复现
前置条件： group session 含 TestAgent/DepsAgent/ReviewAgent

复现步骤：
1. 发送 DAG：`task-b dependsOn task-a`，同时有独立 sibling `task-c`。
2. 确认计划并监听 `task_assigned/task_completed/task_failed/task_blocked`。
3. 观察修复前后继任务会在依赖完成前被分配；前端 `plan_executing` 会把未分配节点也置为 running。

预期结果： 仅无依赖任务先运行；依赖完成后才释放后继；失败任务只阻塞后继，不影响 sibling。
实际结果： 修复前后端只做拓扑排序后一次性入队，跨 Agent 依赖未等待；修复后 DAG execution state 控制 ready task。
复现概率： 必现
影响范围： Planner 确认执行、失败降级、TaskDAG 状态展示。
截图或日志： `evidence/planner-dag-ws-evidence.json`；`evidence/planner-dag-ui-done.png`。
接口信息： `confirm_plan` / `task_assigned` / `task_completed` / `task_failed` / `task_blocked` / `plan_summary`。
初步分析： 调度器把拓扑层展平成 per-agent 队列后立即启动所有 Agent 队列，缺少 plan 级依赖状态机。
修复状态： 已修复 / 已回归
修复方式： 见 fix-and-review-report.md。
Code Review 结果： 通过
修复建议： 后续将 DAG WS 脚本迁入正式集成测试。

## BUG-012

缺陷编号： BUG-012
关联用例： TC-HUB-011
缺陷标题： `/plan` slash command 忽略前端 agentMessageId 导致 UI 确认面板不渲染
严重级别： 严重
优先级： 高
所属模块： WebSocket / Planner UI
测试环境： Chromium Playwright、本地 API/Web、`AGENTHUB_AGENT_PROVIDER=test`
发现方式： Playwright UI 复现 + WS 消息抓取
前置条件： group session 中输入 `/plan Planner DAG UI smoke`

复现步骤：
1. 前端通过 `/api/chat/send` 创建 Planner 占位消息。
2. 前端 WS 发送 `/plan` chat。
3. 后端 slash command 分支生成新的 messageId，stream/plan_result 指向新 ID。
4. 前端占位消息一直 streaming，`Review Task Plan` 不显示。

预期结果： slash command 复用前端创建的 agentMessageId，stream_end 后显示确认面板。
实际结果： 修复前后端生成新 messageId；修复后复用 `data.mentions[0].messageId`。
复现概率： 必现
影响范围： `/plan` UI 主路径、确认执行入口。
截图或日志： 调试截图 `evidence/planner-dag-ui-debug.png`；最终通过截图 `evidence/planner-dag-ui-plan.png`。
接口信息： `/api/chat/send`、WS `chat`、`plan_result`、`stream_end`。
初步分析： slash command 分支未读取前端 mentions 中的 messageId。
修复状态： 已修复 / 已回归
修复方式： 见 fix-and-review-report.md。
Code Review 结果： 通过
修复建议： 为 slash command messageId 复用增加正式单元/集成测试。

## BUG-013

缺陷编号： BUG-013
关联用例： TC-HUB-011 / TC-HUB-019
缺陷标题： 任务消息 ID 跨计划复用导致新任务被误判为已完成并跳过
严重级别： 严重
优先级： 高
所属模块： Planner DAG / 任务调度 / 消息持久化
测试环境： Chromium Playwright、本地 API/Web、`AGENTHUB_AGENT_PROVIDER=test`
发现方式： Playwright UI 回归复现 + API 日志观察
前置条件： DB 中已存在其他计划的 `task-task-1` 消息

复现步骤：
1. 多次运行 Planner UI 确认执行。
2. 新计划包含 `task-1`。
3. 后端检查全局 message id `task-task-1`，命中旧记录后跳过当前任务。

预期结果： 每个 plan/session 的任务消息 ID 唯一，新计划任务不被旧计划影响。
实际结果： 修复前 `task-${taskId}` 全局撞库；修复后使用包含 `planId` 的任务消息 ID。
复现概率： 高频复现
影响范围： Planner DAG 多轮执行、重试、UI 完成态。
截图或日志： API 日志曾出现 `Task dispatch: skipping already-completed task task-1`；最终证据见 `evidence/planner-dag-ui-done.png`。
接口信息： `confirm_plan`、任务消息 DB 记录。
初步分析： 去重逻辑以全局 message id 判断任务是否完成，但 message id 未包含 plan/session 维度。
修复状态： 已修复 / 已回归
修复方式： 见 fix-and-review-report.md。
Code Review 结果： 通过
修复建议： 新 ID 已避免再次碰撞；历史重复 task message 无需迁移。

## BUG-014

缺陷编号： BUG-014
关联用例： TC-HUB-015 / TC-HUB-027 / TC-HUB-029
缺陷标题： 失败任务重试后 DAG 执行态丢失，依赖任务与 Plan Summary 不能恢复
严重级别： 严重
优先级： 高
所属模块： Planner DAG / retry_task / WebSocket 调度
测试环境： `AGENTHUB_AGENT_PROVIDER=test`、本地 API/Web、PostgreSQL/Redis/Docker
发现方式： Code Review + TDD 回归测试 + WS DAG 自动化复现
前置条件： DAG 中 `retry-child dependsOn retry-root`，`retry-root` 首次失败、第二次成功

复现步骤：
1. 确认执行含依赖的 DAG：`retry-root -> retry-child`。
2. 让 `retry-root` 使用 `mock-dag-fail-once` 首次失败，观察 `retry-child` 被标记 blocked。
3. 发送 `retry_task` 重试 `retry-root`。
4. 观察修复前 plan 执行态已在失败汇总后删除，`retry-child` 不会按依赖恢复执行，Plan Summary 仍可能保留旧失败计数。

预期结果： 失败任务重试成功后，DAG 执行态重置该任务及可恢复 blocked 子树；依赖满足后释放后继任务，并重新广播成功的 Plan Summary。
实际结果： 修复后 `retry-root` 第二次完成，`retry-child` 随后执行完成，最终 `plan_summary total=2 completed=2 failed=0`。
复现概率： 修复前必现
影响范围： retry_task、失败恢复、依赖任务释放、Plan Summary 准确性。
截图或日志： `evidence/planner-dag-ws-evidence.json` 的 `retryDag.failedSummarySeen=true`、`retryDag.recoveredSummarySeen=true`、`retryDag.dependentCompletedAfterRetry=true`。
接口信息： `confirm_plan` / `task_failed` / `task_blocked` / `retry_task` / `task_completed` / `plan_summary`。
初步分析： `maybeBroadcastPlanSummary` 在首次终态后删除 plan execution state，`retry_task` 只能重新入队单个任务，无法恢复 blocked 子树或刷新汇总。
修复状态： 已修复 / 已回归
修复方式： 见 fix-and-review-report.md。
Code Review 结果： 通过
修复建议： 后续将 DAG retry WS 脚本迁入正式集成测试。
