# 修复、回归验证与 Code Review 报告

## 修复概况

| 缺陷编号 | 关联用例 | 修改文件 | 修改摘要 | 是否影响其他模块 |
|---|---|---|---|---|
| BUG-001 | TC-SESS-012 | apps/api/src/routes/chat.ts | content 增加 trim 后非空校验 | 影响消息发送参数校验 |
| BUG-002 | TC-AGT-008 | apps/api/src/routes/sessions.ts | 创建会话时校验 agentIds 必须 active | 影响会话创建和 Agent 分配 |
| BUG-003 | TC-AUTH-004 | apps/api/src/routes/auth.ts | GitHub fetch 增加超时，token 失败返回 401/500 | 影响 OAuth callback 异常路径 |
| BUG-004 | TC-OPS-004 | apps/api/src/routes/deploy.ts; apps/api/src/ws/handler.ts; apps/web/src/components/MessageInput.tsx | 非法 deploy target 显式拒绝，前端显示错误 | 影响部署入口 |
| BUG-005 | TC-AGT-028 | apps/web/src/components/MessageInput.tsx | mention popup 限定 group session | 影响消息输入框 |
| BUG-006 | TC-SESS-006 | apps/api/src/routes/sessions.ts | lastMessage 超过 80 字符截断 | 影响会话列表 |
| BUG-007 | TC-SBX-013 / TC-AGT-009 | apps/api/src/agent/ClaudeCodeProcess.ts; apps/api/src/ws/handler.ts; apps/api/src/agent/ClaudeCodeProcess.test.ts | prompt/container 标识与 Agent 配置目录标识拆分，修复 --resume 二次调用失败 | 影响真实 Agent Provider 调用 |
| BUG-008 | TC-SESS-020 / LIVE-READ | apps/api/src/ws/handler.ts | DB message update 完成后再广播 stream_end | 影响消息结束事件和详情查询一致性 |
| BUG-009 | TC-WS-010 / TC-WS-011 / TC-WS-012 / TC-WS-013 / TC-NFR-006 | apps/api/src/agent/ClaudeCodeProcess.ts; apps/api/src/agent/ClaudeCodeProcess.test.ts; apps/api/src/agent/TestAgentProcess.ts; apps/api/src/agent/processFactory.ts; apps/api/src/agent/providers/test.ts; apps/api/src/agent/providers/factory.ts; apps/api/src/config.ts; apps/api/src/ws/handler.ts; apps/api/src/ws/taskDispatcher.ts; apps/api/src/agent/TaskQueue.ts; apps/api/src/agent/PlannerAgent.ts; apps/api/src/agent/TestAgentProcess.test.ts; apps/api/src/agent/providers/factory.test.ts | 新增默认关闭的 mock/test provider；真实 Claude provider Trust OFF 下拦截 mutating tool_use，生成 permission_request，Allow 使用 `--allowedTools` replay，Deny/Timeout 自动结束 | test provider 与真实 Claude provider 权限代理链路均已回归；后续保留 test provider 做低成本确定性回归 |
| BUG-010 | TC-SBX-008 | apps/api/src/agent/ClaudeCodeProcess.ts; apps/api/src/agent/ClaudeCodeProcess.test.ts | 移除 workspace `_env.sh`，改为 Docker `-e` env name 注入 provider env；日志仅输出 auth 有无，不输出 secret 明文；真实 provider 证据确认 workspace 无 env 文件 | 凭据文件/日志暴露问题已修复；模型 provider 凭据仍会作为容器进程环境供 Claude CLI 使用，长期可继续设计凭据代理 |
| BUG-011 | TC-HUB-010 / TC-HUB-011 / TC-HUB-028 / TC-HUB-029 | apps/api/src/ws/dagExecution.ts; apps/api/src/ws/dagExecution.test.ts; apps/api/src/ws/taskDispatcher.ts; apps/api/src/ws/handler.ts; apps/web/src/hooks/useChat.ts; apps/web/src/store/appStore.ts; apps/web/src/components/TaskDAG.tsx | 新增 plan 级 DAG execution state，只调度 ready task，完成后释放后继，失败后广播 `task_blocked`；前端不再在 `plan_executing` 时全部置 running | 影响 Planner DAG 调度与 TaskDAG 状态；已由 WS/UI DAG 回归覆盖 |
| BUG-012 | TC-HUB-011 | apps/api/src/ws/handler.ts; apps/web/src/hooks/useChat.ts | `/plan` slash command 复用前端 mentions 中的 agentMessageId；前端 WS 更新按 agentMessageId 回查 session | 修复 Planner UI 确认面板不渲染；增强多 session 消息路由稳健性 |
| BUG-013 | TC-HUB-011 / TC-HUB-019 | apps/api/src/ws/taskDispatcher.ts | task messageId 改为包含 planId，避免跨计划 `task-${taskId}` 撞库导致跳过 | 影响任务消息 ID；已回归多次 UI/WS DAG 执行 |
| BUG-014 | TC-HUB-015 / TC-HUB-027 / TC-HUB-029 | apps/api/src/ws/dagExecution.ts; apps/api/src/ws/dagExecution.test.ts; apps/api/src/ws/taskDispatcher.ts; apps/api/src/ws/handler.ts; docs/superpowers/reports/evidence/planner-dag-ws-test.ts | retry 时保留 plan execution state，重置失败任务及可恢复 blocked 子树；重试成功后继续释放依赖并重新广播 Plan Summary | 影响失败恢复与汇总准确性；已由单元测试和 WS DAG retry 回归覆盖 |

## 修复验证

- RED：`npx tsx /tmp/agenthub_bug_repros.ts` 修复前复现 BUG-001/002/003/004/005/006。
- RED：`npx tsx /tmp/agenthub_live_agent_tests.ts` 第一轮复现 BUG-007，第二轮复现 BUG-009，并暴露 BUG-008 的查询竞态。
- GREEN：同一脚本修复后通过。
- GREEN：`npx tsx /tmp/agenthub_stream_db_consistency.ts` 通过，确认 BUG-008 修复；`apps/api/src/agent/ClaudeCodeProcess.test.ts` 通过，确认 BUG-007 修复。
- GREEN：`AGENTHUB_AGENT_PROVIDER=test` 后端模式下，`npx tsx /tmp/agenthub_mock_provider_ws_tests.ts` 6/6 通过，覆盖 permission allow/deny、tool/subagent、Planner、无效 permissionId、冲突事件。
- GREEN：`npx tsx /tmp/agenthub_mock_provider_ui_test.ts` 通过，Playwright 验证权限卡片出现、点击 Allow、页面消息和 DB 状态；权限卡片 224ms 可见。
- GREEN：真实 `claude-code` provider 权限三态通过，`REAL-PROVIDER-ALLOW` 写入文件并 `exitCode=0`，`REAL-PROVIDER-DENY` 和 `REAL-PROVIDER-TIMEOUT` 均未写文件并以 `Permission denied by user` 结束；证据见 `evidence/real-provider-permission-evidence.json`。
- GREEN：真实 Playwright UI 权限卡通过，权限卡 2332ms 可见，点击 Allow 后写入 `UI_REAL_PROVIDER_ALLOW`，workspace 未生成 `_env.sh`；证据见 `evidence/real-provider-ui-evidence.json` 和 `evidence/real-provider-ui-permission.png`。
- GREEN：`ClaudeCodeProcess.test.ts` 覆盖 provider env 仅通过 Docker env name 注入、不写 workspace env 文件、docker args 不含测试 token 明文，以及 Trust OFF mutating tool_use 的 Allow replay。
- GREEN：`TC-AUTH-001` 白名单 GitHub OAuth 已由用户在 Playwright 可见浏览器完成真实授权；DB 创建 `JohnSiegfried` 用户记录，`/api/auth/me` 对该用户 JWT 返回 200，证据见 `evidence/oauth-live-evidence.json`。
- GREEN：`TC-AUTH-002` 非白名单账号 `XTC2233` 已由用户在独立 Playwright 可见浏览器完成真实授权；OAuth callback 返回 403 `User not in allowed list`，DB 未创建 `XTC2233`/`xtc2233` 用户，证据见 `evidence/oauth-nonwhitelist-evidence.json`。
- GREEN：`TC-WS-025`、`TC-NFR-008`、`TC-NFR-009`、`TC-NFR-010` 已完成 31 分 31 秒确定性长稳压测；100 并发 WS、30 分钟空闲续发、10w 会话列表和 50 会话沙箱清理均通过，证据见 `long-stability-report.md`。
- GREEN：Planner DAG 确认执行已完成确定性 WS 回归，覆盖依赖等待、兄弟任务并行、失败阻塞、`modify_task`、`retry_task`、失败根任务重试后释放依赖、重复 confirm 去重和循环依赖拒绝；证据见 `evidence/planner-dag-ws-evidence.json`。
- GREEN：Planner DAG UI 回归已通过，Playwright 覆盖 `/plan` 生成确认面板、Tasks DAG 截图、点击 Confirm All、最终 `2/2 done` 和 Plan Summary；证据见 `evidence/planner-dag-ui-evidence.json`、`evidence/planner-dag-ui-plan.png`、`evidence/planner-dag-ui-done.png`。
- TypeScript：API/Web `tsc --noEmit` 均通过。
- 既有测试：`npx tsx --test apps/api/src/agent/*.test.ts apps/api/src/agent/providers/*.test.ts apps/api/src/artifacts/*.test.ts apps/api/src/ws/*.test.ts apps/web/src/lib/*.test.ts`，71/71 通过。
- Playwright：登录页可访问，solo mention、非法 deploy target 可见错误完成回归。

## Code Review 记录

审查结论：已修复代码无新的阻塞性问题；BUG-009 已在 test provider 和真实 Claude provider 路径具备回归证据；BUG-010 的 workspace `_env.sh` 与日志明文暴露已修复；Planner DAG 确认执行的核心调度链路已具备 WS/UI 确定性回归证据。
发现问题：审查时发现 `/deploy unknown` 前端仅 console 输出，已补充用户可见错误并回归；真实 Agent 复测后发现 stream_end/DB 更新竞态，已补充修复并回归；本轮 mock provider 审查发现未知 provider 配置会静默回退 Claude、test provider capability 声明不准确，已改为显式报错和 `persistentSession=false` 并补测试；Planner DAG 回归时发现跨 Agent 依赖未等待、slash command messageId 不一致、task messageId 跨计划撞库，以及失败任务重试后 DAG 执行态丢失，均已修复并回归。
残余风险：Claude CLI 调用真实模型时仍需要模型 provider 凭据进入容器进程环境；当前修复保证不落 workspace 文件、不在 docker args/log 中输出明文。若未来允许 Agent 执行任意 `env`/Bash，需要凭据代理、短期令牌或更强沙箱隔离。
是否重新修改：是。
复审结果：复现脚本、TypeScript、既有测试均通过。

## 修复结论

本轮 14 个缺陷均已修复并回归。BUG-009 已通过 test provider 与真实 Claude provider 完成权限代理 UI/WS/文件系统回归；BUG-010 已通过单元测试和真实 provider 证据确认不再写入 workspace `_env.sh` 且日志不输出凭据明文；BUG-011~BUG-014 已通过 Planner DAG WS/UI 确定性回归。残余风险集中在云部署凭据、8 小时混合长稳、真实 Claude 多 Agent DAG 长任务、人工视觉用例，以及模型 provider 凭据的长期隔离方案，已在风险报告中列出。

## Mock Provider 扩展 (2026-05-25)

### 修改文件

| 文件 | 修改摘要 |
|---|---|
| `apps/api/src/agent/TestAgentProcess.ts` | 新增 `emitHighChunks`、`emitLateChunk`、`emitErrorWithSecret`、`emitStopVerify`、`emitNoSandbox`、`emitQueueTest` 6 种 mock 行为；新增 `isAlive()`、`getGlobalRunningCount()`、`resetGlobalRunningCount()` API；`kill()` 方法改进为先 emit stop 事件再设置 killed 标志 |
| `apps/api/src/agent/TestAgentProcess.test.ts` | 新增 6 条测试覆盖所有新 mock 行为 |
| `apps/api/src/agent/providers/test.ts` | `isAlive()` 方法改为委托 `process.isAlive()` |
| `apps/api/src/apiEdgeCases.test.ts` | **新建**，24 条 API 边缘用例测试，覆盖认证/会话/Agent 管理 |
| `apps/api/src/sandboxIntegration.test.ts` | **新建**，5 条 sandbox Docker 集成测试，覆盖 TC-SBX-001/002/004/005/006 |

### 回归验证

- 新 mock 行为测试：11/11 通过
- API 边缘用例测试：24/24 通过
- 全量回归测试：106/106 通过（新增 35 条：6 mock + 24 API + 5 sandbox，原有 71 条无回归失败）

### Code Review 结果

- Mock 扩展向后兼容，不使用新关键词时不影响现有行为
- `kill()` 方法重构为先 emit 事件再设置 killed 标志，避免事件被跳过
- 所有新增 mock 行为均通过确定性测试验证
