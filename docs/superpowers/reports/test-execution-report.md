# AgentHub 测试执行报告

## 测试概况

- 测试系统：AgentHub — IM 风格多 AI Agent 协作中枢
- 测试版本：本地工作区当前版本
- 测试环境：本地开发环境，API http://localhost:3000，Web http://localhost:5173
- 测试时间：2026-05-24 至 2026-05-25
- 测试范围：TESTCASES.md 全部 230 条用例逐条归档
- 测试报告目录：docs/superpowers/reports/
- 测试人员/Agent：Codex test-engineer + Claude Code
- 使用的 skill：test-engineer、systematic-debugging、test-driven-development、code-review
- 测试结论：不通过

## 测试统计

| 指标 | 数量 |
|---|---:|
| 用例总数 | 230 |
| 实际执行数 | 122 |
| Playwright 执行覆盖 | 41 |
| 接口验证覆盖 | 106 |
| 数据库验证覆盖 | 42 |
| Docker 验证覆盖 | 5 |
| 通过 | 122 |
| 失败 | 0 |
| 阻塞 | 76 |
| 未执行 | 38 |
| 发现缺陷 | 14 |
| 已修复/已回归缺陷 | 14 |
| 已通过测试模式缓解 | 0 |
| 未修复/待确认缺陷 | 0 |
| Code Review 阻塞问题 | 0 |

## Mock Provider 扩展 (2026-05-25)

本次迭代扩展了 `TestAgentProcess`，新增 6 种可控 mock 行为：

| Mock 行为 | 触发关键词 | 解锁用例 |
|---|---|---|
| 高频 chunk 输出 | `mock-high-chunk:N` | TC-WS-020（多 chunk 高频流式不乱序） |
| done 后迟到 chunk | `mock-late-chunk` | TC-WS-021（stream_end 后不追加旧消息） |
| 错误含敏感信息 | `mock-error-secret` | TC-WS-024（错误不暴露敏感环境变量） |
| stop 生命周期验证 | `mock-stop-verify` | TC-SBX-014（Provider stop 后进程退出） |
| 无沙箱错误 | `mock-no-sandbox` | TC-WS-005（无沙箱时 chat 返回错误） |
| 并发队列跟踪 | `mock-queue-test` | TC-AGT-019/020（并发控制/队列测试） |

同时新增 `isAlive()`、`getGlobalRunningCount()`、`resetGlobalRunningCount()` 等 API。

## 新增 API 边缘用例测试

本轮新增 24 条 `node:test` 测试（`apps/api/src/apiEdgeCases.test.ts`），覆盖以下之前阻塞/未执行的 TESTCASES.md 用例：

- **认证**：TC-AUTH-005 ~ TC-AUTH-010（有效/过期/篡改 JWT、跨用户访问/删除）
- **会话**：TC-SESS-003 ~ TC-SESS-009、TC-SESS-012 ~ TC-SESS-015（创建/排序/删除/边界/跨用户）
- **Agent 管理**：TC-AGT-001、TC-AGT-002、TC-AGT-004、TC-AGT-005、TC-AGT-007

测试通过创建真实 DB 用户并签发 JWT 进行端到端 API 验证，无需 Playwright 浏览器。

## 新增 Sandbox Docker 集成测试 (2026-05-25)

本轮新增 5 条 sandbox Docker 集成测试（`apps/api/src/sandboxIntegration.test.ts`），覆盖以下 TESTCASES.md 用例：

- **TC-SBX-001**：首次 WS 连接自动创建 Docker 容器，验证 DB 记录、容器存在、host 工作目录
- **TC-SBX-002**：第二次 WS 连接复用已有容器，验证容器数=1
- **TC-SBX-004**：跨会话工作目录隔离，验证文件不可互读
- **TC-SBX-005**：同会话 Agent 共享工作目录，验证文件可读
- **TC-SBX-006**：会话删除时容器和 host 目录被清理

测试通过创建真实 DB 用户 → POST 创建会话 → WS 连接触发 sandbox 创建 → Docker exec 读写文件 → API DELETE 清理的完整链路验证。TC-SBX-003（沙箱镜像缺失错误）和 TC-SBX-007（资源限制）需要额外 mock/压测环境，未包含在本轮测试中。

## 环境检查结果

- API 服务：已启动，`/api/health` 返回 ok。
- Web 服务：已启动，Playwright 可打开登录页。
- PostgreSQL：Docker 容器 healthy。
- Redis：Docker 容器 healthy。
- Docker 沙箱镜像：`agenthub-sandbox:latest` 存在。
- TypeScript：API/Web 均通过。
- GitHub OAuth 测试账号标识：白名单用户名 `JohnSiegfried`，非白名单用户名 `XTC2233`；`JohnSiegfried` 已通过 Playwright 可见浏览器完成真实 GitHub OAuth 回调，DB 创建用户记录，`/api/auth/me` 对该用户 JWT 返回 200；`XTC2233` 已通过真实 OAuth 回调验证非白名单拒绝，callback 返回 403 且 DB 未创建用户。

## Playwright 实测过程摘要

- 打开登录页，确认 AgentHub 页面渲染。
- 注入测试 JWT，创建 solo/group session。
- 验证 solo 会话不弹出 @ mention 面板。
- 验证非法 `/deploy unknown` 显示用户可见错误。
- 验证删除当前会话、空状态相关页面路径。
- 使用真实 Agent CLI 验证 SmartSupport 长流式输出、读文件、stop、Planner plan_result、多 Agent 并行和基础浏览器 UI。
- 新增默认关闭的 `AGENTHUB_AGENT_PROVIDER=test` mock/test provider 后，复测权限卡片、permission allow/deny、tool_use/tool_result、subagent_start/result、Planner plan_result、无效 permissionId、并行冲突和 UI 权限卡片；WS 6/6 通过，Playwright 权限卡片通过。
- 使用真实 `claude-code` provider 复测 Trust OFF 权限代理：Allow、Deny、Timeout 三态均通过；真实 Playwright 权限卡 2332ms 可见并可 Allow 后写入文件，证据见 `evidence/real-provider-permission-evidence.json`、`evidence/real-provider-ui-evidence.json` 和 `evidence/real-provider-ui-permission.png`。
- 使用 Playwright 可见浏览器执行 `JohnSiegfried` 真实 GitHub OAuth 白名单授权；后端回调后 DB 出现 `JohnSiegfried` 用户记录，证据见 `evidence/oauth-live-evidence.json`。
- 使用独立 Playwright 可见浏览器执行 `XTC2233` 真实 GitHub OAuth 非白名单授权；后端 callback 返回 403 `User not in allowed list`，DB 未创建 `XTC2233`/`xtc2233` 用户，证据见 `evidence/oauth-nonwhitelist-evidence.json`。
- 使用 `AGENTHUB_AGENT_PROVIDER=test` 执行 31 分 31 秒长稳压测：空库/1w/10w 会话列表、50 会话沙箱创建删除、100 并发 WS、30 分钟空闲 WS 续发均通过，证据见 `long-stability-report.md` 与 `evidence/long-stability-evidence.json`。
- 使用 `AGENTHUB_AGENT_PROVIDER=test` 执行 Planner DAG 确认执行回归：WS 覆盖依赖等待、独立兄弟并行、失败阻塞、modify_task、retry_task、失败根任务重试后释放依赖、重复 confirm 去重、循环依赖拒绝；Playwright 覆盖 `/plan` 生成确认面板、点击 Confirm All、Tasks DAG/Plan Summary 最终 `2/2 done`，证据见 `evidence/planner-dag-ws-evidence.json`、`evidence/planner-dag-ui-evidence.json`、`evidence/planner-dag-ui-plan.png`、`evidence/planner-dag-ui-done.png`。

## 用例执行摘要

完整逐条结果见 `testcase-results.md`。

## 缺陷分布

| 严重级别 | 数量 |
|---|---:|
| 阻塞 | 0 |
| 严重 | 10 |
| 一般 | 4 |
| 轻微 | 0 |
| 未修复/阻塞风险 | 0 |

## 已发现问题清单

- BUG-001 (TC-SESS-012) 空白字符串消息被后端接受并写入 DB
- BUG-002 (TC-AGT-008) 软删除 Agent 仍可被指定绑定到 group session
- BUG-003 (TC-AUTH-004) GitHub token 交换失败路径可能长时间挂起且错误状态不明确
- BUG-004 (TC-OPS-004) 非法部署目标被默认映射为 docker 并可能触发部署
- BUG-005 (TC-AGT-028) solo 会话输入 @ 仍弹出 Agent mention 面板
- BUG-006 (TC-SESS-006) 会话列表 lastMessage 未按约定截断
- BUG-007 (TC-SBX-013 / TC-AGT-009) 同一 Agent 第二次调用因 message-scoped CLAUDE_CONFIG_DIR 导致 Claude --resume 立即失败
- BUG-008 (TC-SESS-020 / LIVE-READ) stream_end 早于 DB 内容更新，结束后立即查询可能读到空 agent 消息
- BUG-009 (TC-WS-010 / TC-WS-011 / TC-WS-012 / TC-WS-013 / TC-NFR-006) Trust OFF 写文件任务权限代理；已通过 test provider 和真实 Claude provider 回归，Allow/Deny/Timeout 与 3 秒内权限卡均通过
- BUG-010 (TC-SBX-008) Agent 可在工作区读取 provider 环境文件，服务日志也可能出现工具结果中的凭据内容；已改为 Docker env name 注入并验证 workspace 不再生成 `_env.sh`，日志不输出凭据明文
- BUG-011 (TC-HUB-010/011/028/029) Planner DAG 调度只排序不等待依赖，且前端 `plan_executing` 将全部节点提前置 running；已新增 DAG execution state，按 ready task 调度，失败后阻塞后继。
- BUG-012 (TC-HUB-011) `/plan` slash command 后端忽略前端 agentMessageId，导致 Planner stream_end/plan_result 写不到 UI 占位消息，确认面板不渲染；已复用前端 messageId。
- BUG-013 (TC-HUB-011/019) 任务消息 ID 仅使用 `task-${taskId}`，跨 session/plan 撞库后新任务会被误判为已完成并跳过；已改为包含 planId 的任务消息 ID。
- BUG-014 (TC-HUB-015/027/029) 失败任务重试后 DAG execution state 已删除，依赖 blocked 子树和 Plan Summary 不能恢复；已保留 plan 状态并在 retry 时重置可恢复 blocked 子树。

## 主要风险

权限代理、30 分钟长稳基线和 Planner DAG 确认执行在 test provider 下已可回归，真实 OAuth 白名单/非白名单链路已完成；真实 Claude Code provider 的权限请求、Allow/Deny/Timeout、UI 权限卡和 `_env.sh` 移除已完成回归。云部署、8 小时混合长稳、真实 Claude 多 Agent DAG 长任务、人工视觉类用例，以及模型 provider 凭据的长期隔离方案仍是主要未覆盖风险。

## 上线建议

不通过；不建议直接生产上线。需要先补齐阻塞项中的真实端到端和长稳验证。
