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
| BUG-009 | TC-WS-010 / TC-WS-011 / TC-NFR-006 | apps/api/src/agent/TestAgentProcess.ts; apps/api/src/agent/processFactory.ts; apps/api/src/agent/providers/test.ts; apps/api/src/agent/providers/factory.ts; apps/api/src/config.ts; apps/api/src/ws/handler.ts; apps/api/src/ws/taskDispatcher.ts; apps/api/src/agent/TaskQueue.ts; apps/api/src/agent/PlannerAgent.ts; apps/api/src/agent/TestAgentProcess.test.ts; apps/api/src/agent/providers/factory.test.ts | 新增默认关闭的 mock/test provider，显式环境变量启用；覆盖 permission_request、allow/deny、tool/subagent、Planner、冲突测试事件 | 权限代理测试链路已可自动化回归；真实 Claude provider 限制仍保留风险 |
| BUG-010 | TC-SBX-008 | 未修复 | `_env.sh` 可被 Agent 读取且工具结果可能出现在日志 | 沙箱/日志安全风险 |

## 修复验证

- RED：`npx tsx /tmp/agenthub_bug_repros.ts` 修复前复现 BUG-001/002/003/004/005/006。
- RED：`npx tsx /tmp/agenthub_live_agent_tests.ts` 第一轮复现 BUG-007，第二轮复现 BUG-009，并暴露 BUG-008 的查询竞态。
- GREEN：同一脚本修复后通过。
- GREEN：`npx tsx /tmp/agenthub_stream_db_consistency.ts` 通过，确认 BUG-008 修复；`apps/api/src/agent/ClaudeCodeProcess.test.ts` 通过，确认 BUG-007 修复。
- GREEN：`AGENTHUB_AGENT_PROVIDER=test` 后端模式下，`npx tsx /tmp/agenthub_mock_provider_ws_tests.ts` 6/6 通过，覆盖 permission allow/deny、tool/subagent、Planner、无效 permissionId、冲突事件。
- GREEN：`npx tsx /tmp/agenthub_mock_provider_ui_test.ts` 通过，Playwright 验证权限卡片出现、点击 Allow、页面消息和 DB 状态；权限卡片 224ms 可见。
- GREEN：`TC-AUTH-001` 白名单 GitHub OAuth 已由用户在 Playwright 可见浏览器完成真实授权；DB 创建 `JohnSiegfried` 用户记录，`/api/auth/me` 对该用户 JWT 返回 200，证据见 `oauth-live-evidence.json`。
- DEFERRED：`TC-AUTH-002` 非白名单账号 `hengming0820` 按用户最新要求暂不验证，保持阻塞/待执行。
- TypeScript：API/Web `tsc --noEmit` 均通过。
- 既有测试：`npx tsx --test apps/api/src/agent/*.test.ts apps/api/src/agent/providers/*.test.ts apps/api/src/artifacts/*.test.ts apps/api/src/ws/*.test.ts apps/web/src/lib/*.test.ts`，62/62 通过。
- Playwright：登录页可访问，solo mention、非法 deploy target 可见错误完成回归。

## Code Review 记录

审查结论：已修复代码无新的阻塞性问题；BUG-009 在 test provider 路径已具备确定性回归能力，但真实 Claude provider 权限事件仍需后续架构处理；BUG-010 属于安全风险，保留在风险报告。  
发现问题：审查时发现 `/deploy unknown` 前端仅 console 输出，已补充用户可见错误并回归；真实 Agent 复测后发现 stream_end/DB 更新竞态，已补充修复并回归；本轮 mock provider 审查发现未知 provider 配置会静默回退 Claude、test provider capability 声明不准确，已改为显式报错和 `persistentSession=false` 并补测试。  
是否重新修改：是。  
复审结果：复现脚本、TypeScript、既有测试均通过。

## 修复结论

本轮修复的 8 个缺陷均已回归，BUG-009 已通过 test provider 完成权限代理 UI/WS/DB 回归。真实 Claude provider 权限事件与 BUG-010 凭据暴露风险仍未修复；残余风险集中在真实 OAuth 非白名单拒绝验证、真实 provider 权限代理、云部署凭据、长时压测和人工视觉用例，已在风险报告中列出。
