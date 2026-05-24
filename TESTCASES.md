# AgentHub 测试用例文档

> 生成依据：`PRD.md`、`docs/superpowers/plans/2026-05-18-agenthub-mvp-phase1.md`、`docs/superpowers/plans/2026-05-19-phase2-multi-agent.md`、`docs/superpowers/plans/2026-05-23-phase3-smart-hub-core.md`、`docs/superpowers/plans/2026-05-23-phase4-artifacts-deployment.md`。  
> 设计方法：正向、反向/异常、边界值、等价类、状态与流程、场景法，并叠加接口、功能、性能、自动化候选标准。  
> 用例总数：230 条。

## 覆盖摘要

| 覆盖域 | 用例数 | 重点 |
|---|---:|---|
| 认证与安全边界 | 15 | GitHub OAuth、白名单、JWT、跨用户访问、WebSocket 鉴权 |
| 会话与消息基础链路 | 20 | 单聊/群聊会话、消息持久化、列表、删除、刷新恢复 |
| WebSocket、流式与权限代理 | 25 | 连接状态、流式事件、权限卡片、超时、异常恢复 |
| 沙箱、Agent 进程与 Provider | 20 | Docker 沙箱、进程生命周期、REPL/one-shot、事件标准化 |
| Agent 管理、@ 提及与多 Agent 群聊 | 30 | Agent CRUD、Mention 解析、并行消息、状态面板 |
| Smart Hub、Planner、TaskDAG 与任务路由 | 35 | 复杂任务拆解、DAG 确认/修改、REPL 分发、缺失 Agent、失败降级 |
| 工作区、Diff、版本历史与冲突 | 25 | 快照、Diff 卡片、accept/reject、版本回退、冲突检测 |
| 产物预览、文档/PPT/代码二次交互 | 20 | iframe 预览、Markdown、PPT、代码编辑、引用再处理 |
| 部署、测试、安全检查与审查报告 | 20 | `/deploy`、回滚、TestReport、SecurityCard、ReviewCard |
| 非功能、性能、可靠性与复杂端到端 | 20 | 并发、容量、资源泄漏、复杂多 Agent 项目任务 |

## 测试数据与环境约定

- 本地测试环境可使用可重置 PostgreSQL/Redis/Docker。
- 至少准备两个 GitHub 白名单用户：`userA`、`userB`，用于跨用户/权限用例。
- 默认 Agent：`code-agent`、`review-agent`、`devops-agent`、`planner`；可按用例创建自定义 Agent。
- 自动化标记遵循：P0 全部应优先自动化，P1 大部分自动化，视觉/主观判断类标为需人工。

## 认证与安全边界

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-AUTH-001 | GitHub 白名单用户可完成登录 | `/api/auth/github/callback` | 正向 | P0 | `.env` 配置合法 GitHub OAuth，`userA` 在白名单 | 1. 打开登录页；2. 走 GitHub 授权；3. 回调到前端 | 前端获得 JWT 并进入聊天页；用户记录被 upsert | OAuth callback | 302 到 `/auth/callback?token=`；JWT 可验签 | [可自动化] |
| TC-AUTH-002 | 非白名单用户登录被拒绝 | `/api/auth/github/callback` | 反向 | P0 | `userB` 不在 `ALLOWED_USERS` | 1. 使用 `userB` 授权；2. 观察回调 | 登录失败，不签发可用 JWT | OAuth callback | 403 或错误页；DB 不创建可访问会话 | [可自动化] |
| TC-AUTH-003 | GitHub code 缺失时回调失败 | `/api/auth/github/callback` | 异常 | P1 | API 服务运行 | 1. 请求 callback 但不带 `code`；2. 读取响应 | 返回明确错误，不创建用户 | GET callback | 400；错误体包含缺少 code | [可自动化] |
| TC-AUTH-004 | GitHub token 换取失败时不登录 | `/api/auth/github/callback` | 异常 | P1 | mock GitHub token 接口返回 401 | 1. 发起 callback；2. 模拟 token 失败 | 返回登录失败，不生成 JWT | GET callback | 401/500；无 token | [可自动化] |
| TC-AUTH-005 | `/api/auth/me` 带有效 JWT 返回当前用户 | `/api/auth/me` | 正向 | P0 | 已登录 `userA` | 1. 带 Bearer token 请求；2. 校验用户信息 | 返回 `id/login/avatarUrl/email` | GET | 200；字段类型正确 | [可自动化] |
| TC-AUTH-006 | `/api/auth/me` 无 Token 被拒绝 | `/api/auth/me` | 认证 | P0 | 无 | 1. 不带 Authorization 请求；2. 读取响应 | 认证失败，不返回用户信息 | GET | 401 | [可自动化] |
| TC-AUTH-007 | 过期 JWT 被拒绝 | `/api/auth/me` | 认证 | P0 | 构造过期 token | 1. 带过期 token 请求；2. 读取响应 | 认证失败，提示重新登录 | GET | 401 | [可自动化] |
| TC-AUTH-008 | 篡改 JWT 签名被拒绝 | `/api/auth/me` | 安全 | P0 | 有效 token 一枚 | 1. 修改 token payload；2. 请求接口 | 服务拒绝篡改 token | GET | 401；无用户信息泄漏 | [可自动化] |
| TC-AUTH-009 | 跨用户访问会话被拒绝 | `/api/sessions/:id` | 权限 | P0 | `userA` 有 session，`userB` 登录 | 1. `userB` 请求 `userA` session；2. 读取响应 | 不返回会话和消息 | GET | 404/403；响应不含消息内容 | [可自动化] |
| TC-AUTH-010 | 跨用户删除会话无效 | `/api/sessions/:id` | 权限 | P0 | `userA` 有 session，`userB` 登录 | 1. `userB` DELETE；2. `userA` 再读取 | 删除被拒绝，会话仍存在 | DELETE | 404/403；数据未变 | [可自动化] |
| TC-AUTH-011 | WebSocket 缺 token 以策略违规关闭 | `/ws` | 认证 | P0 | API 服务运行 | 1. 连接 `ws?sessionId=valid`；2. 监听 close | 连接关闭并返回错误消息 | WS connect | close code 1008；消息 Missing token | [可自动化] |
| TC-AUTH-012 | WebSocket 缺 sessionId 以策略违规关闭 | `/ws` | 认证 | P0 | 有效 JWT | 1. 连接 `ws?token=valid`；2. 监听 close | 连接关闭并提示缺少参数 | WS connect | close code 1008 | [可自动化] |
| TC-AUTH-013 | WebSocket 无效 token 被拒绝 | `/ws` | 认证 | P0 | 有 sessionId | 1. 连接 `token=bad`；2. 监听 close | 不建立会话客户端 | WS connect | close code 1008；Invalid token | [可自动化] |
| TC-AUTH-014 | WebSocket 用户不存在时要求重新认证 | `/ws` | 权限 | P1 | JWT 指向已删除 userId | 1. 使用孤儿 token 连接；2. 监听消息 | 连接关闭，提示重新认证 | WS connect | error message；close | [可自动化] |
| TC-AUTH-015 | 生产部署需双重确认 | `/api/deploy` / WS | 安全 | P0 | 有会话和沙箱 | 1. 触发生产部署但确认短语错误；2. 观察状态卡 | 部署失败且不执行生产动作 | `deploy_to_platform` | `deployment_status failed`；错误提示确认短语 | [可自动化] |

## 会话与消息基础链路

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-SESS-001 | 创建 solo 会话 | `/api/sessions` | 正向 | P0 | `userA` 已登录 | 1. POST 空 body 或 `{type:"solo"}`；2. 查询列表 | 创建 solo 会话，属于当前用户 | POST | 201/200；`type=solo` | [可自动化] |
| TC-SESS-002 | 创建 group 会话自动绑定默认 Agent | `/api/sessions` | 正向 | P0 | 默认 Agents 已 seed | 1. POST `{type:"group"}`；2. 查询详情 | SessionAgent 存在，含默认 Agent | POST/GET | `agents.length>=3` | [可自动化] |
| TC-SESS-003 | 创建 group 会话指定 agentIds | `/api/sessions` | 正向 | P1 | 已有自定义 Agent | 1. POST `{type:"group",agentIds:[...]}`；2. 查询详情 | 仅绑定指定 Agent 或按规则补齐 | POST | 返回 agents 与请求一致 | [可自动化] |
| TC-SESS-004 | 创建会话 type 非法被拒绝 | `/api/sessions` | 反向 | P1 | 已登录 | 1. POST `{type:"bad"}` | 不创建会话，返回参数错误 | POST | 400；错误字段指向 type | [可自动化] |
| TC-SESS-005 | 获取会话列表按最近更新时间排序 | `/api/sessions` | 正向 | P1 | 有 3 个会话并分别发消息 | 1. 请求列表；2. 比较顺序 | 最新活跃会话排最前 | GET | created/updated 排序正确 | [可自动化] |
| TC-SESS-006 | 会话列表展示 lastMessage 截断 | `/api/sessions` | 边界 | P2 | 会话最后消息 >80 字 | 1. 请求列表；2. 查看 lastMessage | lastMessage 存在且不会过长 | GET | 长度符合约定 | [可自动化] |
| TC-SESS-007 | 获取会话详情返回消息升序 | `/api/sessions/:id` | 正向 | P0 | 会话有多条消息 | 1. GET 详情；2. 校验 createdAt | 消息按时间升序，含 agentId/status | GET | 200；顺序正确 | [可自动化] |
| TC-SESS-008 | 获取不存在会话返回 404 | `/api/sessions/:id` | 反向 | P0 | 已登录 | 1. GET 随机 UUID | 返回不存在，不泄漏信息 | GET | 404 | [可自动化] |
| TC-SESS-009 | 删除自己的会话级联消息 | `/api/sessions/:id` | 正向 | P1 | 会话有多条消息 | 1. DELETE 会话；2. 查询详情和消息 | 会话不可读，消息级联删除或不可见 | DELETE/GET | 204/200；后续 404 | [可自动化] |
| TC-SESS-010 | 删除会话时清理运行资源 | 会话/沙箱 | 状态 | P1 | 会话有 active WS 和沙箱 | 1. 删除会话；2. 检查 WS/进程/容器 | 资源被停止或进入清理队列 | DELETE + Docker | 无孤儿 active process | [可自动化] |
| TC-SESS-011 | REST 发送普通消息创建 human 与 agent 占位 | `/api/chat` | 正向 | P0 | solo 会话存在 | 1. POST content；2. 查询消息 | human done，agent streaming 占位创建 | POST | 返回 userMessageId/agentMessageId | [可自动化] |
| TC-SESS-012 | 发送空消息被拒绝 | `/api/chat` | 边界 | P0 | 会话存在 | 1. POST `content:""`；2. POST 空白字符串 | 不创建消息 | POST | 400；消息数量不变 | [可自动化] |
| TC-SESS-013 | 发送超长消息可处理或给出明确错误 | `/api/chat` | 边界 | P1 | 会话存在 | 1. POST 64KB 文本；2. 观察响应 | 不崩溃；按限制接收或返回 400/413 | POST | 响应明确，DB 状态一致 | [可自动化] |
| TC-SESS-014 | sessionId 缺失被拒绝 | `/api/chat` | 参数 | P0 | 已登录 | 1. POST 仅 content | 参数错误 | POST | 400 | [可自动化] |
| TC-SESS-015 | 非本人 sessionId 发送消息被拒绝 | `/api/chat` | 权限 | P0 | `userA` session，`userB` token | 1. `userB` POST 到 `userA` session | 不创建消息 | POST | 404/403 | [可自动化] |
| TC-SESS-016 | 刷新页面后恢复会话和历史消息 | 前端会话 | 场景 | P0 | 已登录并有消息历史 | 1. 刷新浏览器；2. 进入同会话 | 会话列表和消息历史恢复 | UI/API | 消息一致，无重复 | [可自动化] |
| TC-SESS-017 | 多标签页切换会话状态互不污染 | 前端状态 | 场景 | P1 | 浏览器打开两个标签 | 1. 标签 A 切 session1；2. 标签 B 切 session2；3. 分别发送 | 各自消息落入对应会话 | UI/WS | sessionId 正确 | [需人工] |
| TC-SESS-018 | 无会话时显示空状态 | 前端会话 | 功能 | P2 | 新用户无 session | 1. 登录；2. 查看首页 | 显示创建入口，不报错 | UI | 无 JS error | [可自动化] |
| TC-SESS-019 | 删除当前会话后自动选择可用会话或空状态 | 前端会话 | 状态 | P2 | 至少 2 个会话 | 1. 删除当前会话；2. 观察 UI | 不停留在不存在会话；状态一致 | UI/API | activeSession 合理 | [可自动化] |
| TC-SESS-020 | 消息状态从 streaming 正确变为 done/error | 消息状态 | 状态 | P0 | agent 可运行 | 1. 发送消息；2. 等待结束 | 状态更新且 UI 不再显示加载 | WS stream_end | DB 和 store 一致 | [可自动化] |

## WebSocket、流式与权限代理

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-WS-001 | 有效连接返回 connected | `/ws` | 正向 | P0 | 有效 token 和 session | 1. 建立 WS；2. 监听首条消息 | 返回 connected，sessionId 正确 | WS connect | `type=connected` | [可自动化] |
| TC-WS-002 | 连接前早到消息被缓存后执行 | `/ws` | 状态 | P1 | 沙箱创建较慢 | 1. 建连后立即发 chat；2. 等 connected 后观察 | early message 被 flush，不丢失 | WS chat | 收到 stream 事件 | [可自动化] |
| TC-WS-003 | 未知消息类型返回错误 | `/ws` | 反向 | P1 | WS 已连接 | 1. 发送 `{type:"unknown"}` | 收到错误，不断开连接 | WS message | error includes Unknown message type | [可自动化] |
| TC-WS-004 | chat 缺 content/prompt 返回 stream_error | `/ws` | 参数 | P0 | WS 已连接 | 1. 发送 `{type:"chat"}` | 返回缺少内容错误 | WS chat | `stream_error` | [可自动化] |
| TC-WS-005 | 无沙箱时 chat 返回错误 | `/ws` | 异常 | P1 | 人工清理当前 sandboxes map 或 mock | 1. 发送 chat | 返回 No active sandbox，不崩溃 | WS chat | `stream_error` | [可自动化] |
| TC-WS-006 | 单 Agent 文本流式追加到同一消息 | WS stream | 正向 | P0 | agent 可输出多段 text | 1. 发送消息；2. 监听 stream_chunk | chunks 按顺序追加到 agentMessageId | `stream_chunk` | 内容顺序一致 | [可自动化] |
| TC-WS-007 | tool_use 事件进入状态面板 | WS status | 正向 | P1 | Agent 会调用工具 | 1. 发送需要读写文件的任务；2. 监听事件 | AgentStatusPanel 显示工具名和输入预览 | `agent_status` | `status=tool_use` | [可自动化] |
| TC-WS-008 | tool_result 事件显示结果摘要 | WS status | 正向 | P2 | Agent 会返回工具结果 | 1. 触发工具；2. 监听状态 | 面板展示结果预览且不过度撑开 | `agent_status` | `status=tool_result` | [可自动化] |
| TC-WS-009 | subagent_start/result 成对显示 | WS status | 场景 | P2 | Agent 触发子 Agent | 1. 发送复杂分析任务；2. 监听子 Agent 事件 | 面板显示子 Agent 启动和完成 | `agent_status` | 子事件顺序合理 | [可自动化] |
| TC-WS-010 | permission_request 生成权限卡片 | 权限代理 | 正向 | P0 | Trust OFF，Agent 请求 Write | 1. 发送写文件任务；2. 监听 permission_request | UI 出现权限卡片，含工具和路径 | `permission_request` | 3s 内推送 | [可自动化] |
| TC-WS-011 | 允许权限后 Agent 继续执行 | 权限代理 | 正向 | P0 | 存在权限请求 | 1. 点击允许；2. 观察后续 stream | stdin 收到允许，Agent 继续完成 | `permission_response` | 后续 `stream_end exitCode=0` | [可自动化] |
| TC-WS-012 | 拒绝权限后 Agent 进入错误或替代路径 | 权限代理 | 反向 | P1 | 存在权限请求 | 1. 点击拒绝；2. 观察结果 | Agent 不执行被拒操作，状态可结束 | `permission_response` | 文件未改变 | [可自动化] |
| TC-WS-013 | 权限 120s 超时自动拒绝 | 权限代理 | 边界 | P1 | 可配置较短 timeout 或 fake timer | 1. 不响应权限卡；2. 等超时 | 自动发送 deny，卡片状态更新 | timeout | 无挂起权限 | [可自动化] |
| TC-WS-014 | permissionId 无效被拒绝 | 权限代理 | 反向 | P1 | WS 已连接 | 1. 发送不存在 permissionId 响应 | 返回错误，不影响其他 Agent | `permission_response` | `stream_error` | [可自动化] |
| TC-WS-015 | stop_agent 停止运行中 Agent | Agent 控制 | 正向 | P0 | Agent 正在长任务 | 1. 发送 stop_agent；2. 观察状态 | 进程停止，消息结束为 stopped | `stop_agent` | `stream_end stopped=true` | [可自动化] |
| TC-WS-016 | 停止不存在 Agent 返回错误 | Agent 控制 | 反向 | P1 | WS 已连接 | 1. 发送不存在 agentMessageId | 返回 Agent not found | `stop_agent` | `stream_error` | [可自动化] |
| TC-WS-017 | 连接关闭清理当前客户端但不影响同会话其他客户端 | WS 多客户端 | 状态 | P1 | 同 session 两个 WS | 1. 关闭客户端 A；2. 客户端 B 发消息 | B 仍正常收消息 | close/chat | sessions set 仍含 B | [可自动化] |
| TC-WS-018 | Agent 执行超时后资源释放 | Agent 控制 | 异常 | P1 | 设置短 timeout | 1. 发长时间任务；2. 等超时 | 进程 kill，running count 减少 | timer | `stream_error timeout` | [可自动化] |
| TC-WS-019 | agent start 异常更新消息为 error | Agent 控制 | 异常 | P0 | mock provider start 抛错 | 1. 发消息；2. 查询 DB | agent message status=error | WS/DB | error 可见，计数释放 | [可自动化] |
| TC-WS-020 | 多 chunk 高频流式不乱序 | WS stream | 并发 | P1 | mock agent 高频输出 | 1. 发送 100 chunks；2. 收集内容 | UI 和 DB 顺序一致，无丢 chunk | `stream_chunk` | 序列完整 | [可自动化] |
| TC-WS-021 | stream_end 后不会继续追加旧消息 | WS stream | 状态 | P1 | mock done 后仍输出旧 chunk | 1. 发送消息；2. done 后发迟到 chunk | 迟到 chunk 被忽略或不污染新消息 | `stream_end` | 消息内容稳定 | [可自动化] |
| TC-WS-022 | 断线重连后不重复执行同一已确认计划 | WS 重连 | 幂等 | P0 | 已发送 confirm_plan | 1. 断开重连；2. 重发 buffered confirm_plan | dispatchedPlans 去重，不重复分发 | `confirm_plan` | 无重复 task_assigned | [可自动化] |
| TC-WS-023 | 同一 session 的不同 agentMessageId 状态隔离 | WS 多 Agent | 并发 | P0 | group session | 1. 并行触发两个 Agent；2. 交错输出 | chunk/status 路由到正确消息 | `stream_chunk` | agentMessageId 匹配 | [可自动化] |
| TC-WS-024 | WebSocket 服务器错误不暴露敏感环境变量 | WS 安全 | 安全 | P1 | mock 内部异常 | 1. 触发异常；2. 查看错误消息 | 错误简洁，不含 token/secret/env | `stream_error` | 无敏感关键词 | [可自动化] |
| TC-WS-025 | 心跳或长连接空闲期间不误断开活跃会话 | WS 稳定 | 稳定性 | P2 | 长时间连接 | 1. 空闲 30 分钟；2. 再发消息 | 连接可用或自动重连后可用 | WS | 无消息丢失 | [可自动化] |

## 沙箱、Agent 进程与 Provider

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-SBX-001 | 首次连接会话自动创建沙箱 | SandboxManager | 正向 | P0 | session 无 containerId | 1. 连接 WS；2. 查询 session | 创建容器并保存 sandboxContainerId | WS connect | 容器存在且 running | [可自动化] |
| TC-SBX-002 | 已有沙箱复用不重复创建 | SandboxManager | 幂等 | P1 | session 已有 running sandbox | 1. 重连 WS；2. 观察 Docker | 不创建第二个同名容器 | WS connect | 容器数=1 | [可自动化] |
| TC-SBX-003 | 沙箱镜像缺失时给出明确错误 | SandboxManager | 异常 | P1 | 配置不存在 image | 1. 建连；2. 观察消息 | 连接关闭，提示 sandbox failed | WS connect | error message 明确 | [可自动化] |
| TC-SBX-004 | 每会话工作目录隔离 | SandboxManager | 安全 | P0 | userA 两个 session | 1. session1 写文件；2. session2 查文件 | session2 不可见 session1 文件 | Docker/files | 目录隔离 | [可自动化] |
| TC-SBX-005 | 多 Agent 同会话共享工作目录 | SandboxManager | 场景 | P0 | group session | 1. CodeAgent 写文件；2. ReviewAgent 读取 | ReviewAgent 能读取同会话文件 | WS tasks | 文件可见 | [可自动化] |
| TC-SBX-006 | 会话清理时销毁孤儿容器 | SandboxManager | 稳定性 | P1 | 会话过期或删除 | 1. 删除/超时；2. 执行清理 | 容器停止并移除或标记清理 | cleanup | 无孤儿容器 | [可自动化] |
| TC-SBX-007 | 沙箱资源限制生效 | Docker | 边界 | P1 | 配置 CPU/内存限制 | 1. Agent 执行高资源任务；2. 观察容器 | 超限被限制，不拖垮宿主 | Docker stats | CPU/内存不越界 | [可自动化] |
| TC-SBX-008 | Agent 环境变量白名单过滤 | ClaudeCodeProcess | 安全 | P0 | 宿主含敏感 env | 1. 启动 agent；2. 输出 env | 只注入允许的 provider/env，不泄漏 GitHub secret | process env | 无敏感变量 | [可自动化] |
| TC-SBX-009 | EventParser 解析 assistant text | EventParser | 正向 | P0 | 有 sample JSON line | 1. 输入 assistant text event | 返回 text/thinking 内容 | parser | content 正确 | [可自动化] |
| TC-SBX-010 | EventParser 忽略结构性空事件 | EventParser | 边界 | P1 | sample system/init event | 1. 输入无内容事件 | 返回 null，不报错 | parser | null | [可自动化] |
| TC-SBX-011 | EventParser 非 JSON 当文本处理 | EventParser | 异常 | P1 | 非 JSON 输出 | 1. 输入普通文本行 | 作为 text 事件输出 | parser | type=text | [可自动化] |
| TC-SBX-012 | UnifiedAgentEvent 转换覆盖所有事件类型 | Provider 抽象 | 正向 | P0 | 准备 parsed events | 1. 转换 thinking/tool/done/error 等 | 均映射为统一事件 | parser | 字段完整 | [可自动化] |
| TC-SBX-013 | Claude Code REPL Provider 可启动并 isAlive | Provider | 正向 | P0 | CLI 凭据可用 | 1. start provider；2. 调 isAlive | 进程活跃，可接受 prompt | provider.start | isAlive=true | [可自动化] |
| TC-SBX-014 | Provider stop 后进程退出 | Provider | 状态 | P0 | Provider running | 1. 调 stop；2. 观察进程 | 进程退出，isAlive=false | provider.stop | 无遗留 pid | [可自动化] |
| TC-SBX-015 | Provider write 可向 stdin 写入权限响应 | Provider | 正向 | P1 | Provider 等待输入 | 1. 调 write("y\n") | Agent 继续执行 | provider.write | 后续事件出现 | [可自动化] |
| TC-SBX-016 | REPL 不可用时 fallback one-shot | Provider | 降级 | P1 | mock REPL start 失败 | 1. 发送任务；2. 观察路径 | 使用 ClaudeCodeProcess one-shot，仍有结果 | WS chat | stream_end 或明确错误 | [可自动化] |
| TC-SBX-017 | one-shot 记录 Claude session id 并按 session+agent 隔离 | ClaudeCodeProcess | 状态 | P1 | 同 agent 名跨两个 session | 1. 各发一轮；2. 检查 session 映射 | session id 不互串 | process callback | key=`sessionId:agentName` | [可自动化] |
| TC-SBX-018 | buildSafeEnv 不包含未授权变量 | Provider | 安全 | P0 | 设置多个宿主 env | 1. 调 buildSafeEnv；2. 检查结果 | 仅保留允许变量 | function | 无 SECRET 泄漏 | [可自动化] |
| TC-SBX-019 | Agent 内部目录初始化包含独立 CLAUDE.md 和 memory | AgentDirectory | 正向 | P1 | group session agent 启动 | 1. 启动 Agent；2. 查看 `_agent_name` | 目录和 memory 存在 | filesystem | 文件结构正确 | [可自动化] |
| TC-SBX-020 | Agent settings 注入到目录初始化 | AgentDirectory | 正向 | P1 | Agent 有 settings JSON | 1. 启动 Agent；2. 查看生成配置 | settings 被写入/应用，不破坏 prompt | filesystem | 配置可读 | [可自动化] |

## Agent 管理、@ 提及与多 Agent 群聊

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-AGT-001 | 默认 Agent seed 成功 | `/api/agents` | 正向 | P0 | 应用启动 | 1. GET agents；2. 检查名称 | 返回 CodeAgent/ReviewAgent/DevOpsAgent/Planner | GET | `agents.length>=3` | [可自动化] |
| TC-AGT-002 | Agent 列表仅返回 active | `/api/agents` | 正向 | P1 | 有软删除 Agent | 1. GET agents | 不返回 inactive Agent | GET | active=true | [可自动化] |
| TC-AGT-003 | 创建自定义 Agent | `/api/agents` | 正向 | P1 | 已登录 | 1. POST name/displayName/systemPrompt | 创建成功，可用于 group | POST | 201；字段正确 | [可自动化] |
| TC-AGT-004 | 创建 Agent 缺 name 被拒绝 | `/api/agents` | 参数 | P1 | 已登录 | 1. POST 缺 name | 参数错误 | POST | 400 | [可自动化] |
| TC-AGT-005 | 创建重复 name 被拒绝或幂等处理 | `/api/agents` | 边界 | P1 | 已有同名 Agent | 1. POST 同 name | 不产生重复活跃 Agent | POST | 409/400 或返回 existing | [可自动化] |
| TC-AGT-006 | 更新 Agent systemPrompt 生效 | `/api/agents/:id` | 正向 | P1 | 自定义 Agent | 1. PUT 新 prompt；2. 发送消息 | Agent 使用新 prompt | PUT/WS | DB 与行为一致 | [可自动化] |
| TC-AGT-007 | 更新不存在 Agent 返回 404 | `/api/agents/:id` | 反向 | P2 | 已登录 | 1. PUT 随机 id | 返回不存在 | PUT | 404 | [可自动化] |
| TC-AGT-008 | 软删除 Agent 后不可再分配 | `/api/agents/:id` | 状态 | P1 | 自定义 Agent 在列表中 | 1. DELETE；2. 创建 group 指定该 id | 删除成功，后续分配被拒或忽略 | DELETE/POST | active=false | [可自动化] |
| TC-AGT-009 | 普通消息在 solo 会话默认路由 code-agent | Turn 路由 | 正向 | P0 | solo session | 1. 发送无 @ 消息 | 选择 CodeAgent | WS chat | agentId=code-agent | [可自动化] |
| TC-AGT-010 | 普通消息在 group 会话默认路由 planner | Turn 路由 | 正向 | P0 | group session 含 planner | 1. 发送无 @ 消息 | Planner 作为默认主持人响应 | WS chat | agentId=planner | [可自动化] |
| TC-AGT-011 | `/` 指令透明透传 | MessageInput/WS | 正向 | P0 | 会话存在 | 1. 输入 `/help`；2. 观察 prompt | 不当作 @ 指令解析；原样给 Agent | WS chat | subPrompt=`/help` | [可自动化] |
| TC-AGT-012 | @CodeAgent 精确匹配 | mentionParser | 正向 | P0 | agents 已加载 | 1. 输入 `@CodeAgent 写脚本` | 解析出 code-agent 和子 prompt | parseMentions | agentId 正确 | [可自动化] |
| TC-AGT-013 | @code-agent kebab 名匹配 | mentionParser | 等价类 | P1 | agents 已加载 | 1. 输入 `@code-agent task` | 解析成功 | parseMentions | normalize 生效 | [可自动化] |
| TC-AGT-014 | DisplayName 前缀匹配 | mentionParser | 等价类 | P1 | ReviewAgent displayName 存在 | 1. 输入 `@Review 审查` | 匹配 ReviewAgent | parseMentions | agentId 正确 | [可自动化] |
| TC-AGT-015 | 空 @ 查询弹出全部 Agent | mention popup | 边界 | P0 | group session | 1. 输入 `@`；2. 观察弹窗 | 展示全部可选 agents | matchAgents | 返回全部 | [可自动化] |
| TC-AGT-016 | Mention 模糊无匹配时不创建错误 Agent | mentionParser | 反向 | P1 | agents 已加载 | 1. 输入 `@NoSuch task` | 不匹配或作为普通文本处理 | parseMentions | 无非法 agentId | [可自动化] |
| TC-AGT-017 | 多 @ 提及生成多个 agent 占位消息 | `/api/chat` | 正向 | P0 | group session | 1. 发送 `@CodeAgent A @ReviewAgent B` | 创建两个 agent placeholder | POST | `agentMessages.length=2` | [可自动化] |
| TC-AGT-018 | 多 Agent 并行流式返回到独立气泡 | WS 群聊 | 并发 | P0 | group session | 1. 并行 @ 两个 Agent；2. 观察 UI | 两个气泡独立 streaming/done | WS | 不串消息 | [可自动化] |
| TC-AGT-019 | 同一 Agent 快速三次任务进入队列 | Agent 队列 | 边界 | P1 | group session | 1. 连续 @CodeAgent 三个任务 | 队列顺序执行或按限制并发 | WS | 无丢任务 | [可自动化] |
| TC-AGT-020 | 第四个同时运行 Agent 被限制 | 并发控制 | 边界 | P0 | `PER_SESSION_MAX=3` | 1. 同 session 触发 4 个 Agent | 第 4 个收到上限错误 | WS chat | `stream_error Max 3` | [可自动化] |
| TC-AGT-021 | 全局 maxConcurrent 生效 | 并发控制 | 边界 | P0 | 配置全局上限 | 1. 多 session 同时启动超过上限 | 超出请求被拒绝或排队 | WS chat | running count 不超限 | [可自动化] |
| TC-AGT-022 | 群聊状态面板仅在 group session 显示 | 前端 UI | 功能 | P2 | 有 solo 和 group | 1. 切 solo；2. 切 group | solo 无右侧 Agent 面板，group 显示 | UI | 条件渲染正确 | [可自动化] |
| TC-AGT-023 | AgentCard 显示运行、完成、空闲状态 | AgentStatusPanel | 状态 | P1 | group session | 1. 启动/完成 Agent；2. 观察卡片 | 状态从 running 到 done/idle | UI/WS | 状态同步 | [可自动化] |
| TC-AGT-024 | AgentCard 展示 token/tool/subagent 摘要 | AgentStatusPanel | 正向 | P2 | Agent 有状态事件 | 1. 触发工具与 token 事件 | 卡片展示摘要且格式稳定 | UI | 字段可见 | [可自动化] |
| TC-AGT-025 | 状态面板聚合模式折叠空闲 Agent | AgentStatusPanel | UI | P2 | 多 Agent 有空闲/运行 | 1. 切聚合模式 | 空闲折叠，运行展开 | UI | 计数正确 | [可自动化] |
| TC-AGT-026 | 状态面板仅异常模式过滤正常 Agent | AgentStatusPanel | UI | P2 | 有 permission/error Agent | 1. 切仅异常模式 | 只显示异常或待权限 Agent | UI | 过滤正确 | [可自动化] |
| TC-AGT-027 | Agent 消息气泡颜色和头像首字母正确 | MessageBubble | UI | P2 | 多 Agent 消息 | 1. 观察 Code/Review/DevOps | 颜色、名称、头像区分明显 | UI | 无混淆 | [需人工] |
| TC-AGT-028 | solo 会话不弹出 @ mention 面板 | MessageInput | 功能 | P2 | solo session | 1. 输入 `@` | 不显示或禁用 Agent 选择 | UI | 无误导 | [可自动化] |
| TC-AGT-029 | 键盘导航选择 mention | MessageInput | UI | P2 | group session | 1. 输入 `@`；2. 上下键；3. Enter | 正确插入选中 Agent 标签 | UI | 输入框内容正确 | [可自动化] |
| TC-AGT-030 | 群聊历史上下文按会话构建且不过度膨胀 | buildHistory | 边界 | P1 | 会话有 >20 消息 | 1. 发送新任务；2. 检查 prompt history | 只注入最近约定条数，不跨会话 | prompt | 无跨会话内容 | [可自动化] |

## Smart Hub、Planner、TaskDAG 与任务路由

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-HUB-001 | Planner 普通主持人模式不输出 JSON | Planner | 正向 | P0 | group session 默认 planner | 1. 发送闲聊/简单问题 | Planner 自然回复，不出现 TaskPlan JSON | WS chat | 无 `plan_result` | [可自动化] |
| TC-HUB-002 | 触发词激活任务规划模式 | Planner | 正向 | P0 | group session | 1. 输入“请制定计划实现登录模块” | Planner 输出 TaskPlan，前端显示 DAG | `plan_result` | tasks 3-8 个 | [可自动化] |
| TC-HUB-003 | fenced JSON TaskPlan 可解析 | extractPlannerPlan | 正向 | P0 | 准备 ```json 计划 | 1. 输入 parser | 返回 TaskPlan | function | planTitle/tasks 正确 | [可自动化] |
| TC-HUB-004 | bare JSON TaskPlan 可解析 | extractPlannerPlan | 等价类 | P1 | 准备裸 JSON | 1. 输入 parser | 返回 TaskPlan | function | tasks 正确 | [可自动化] |
| TC-HUB-005 | 普通文本不误解析为计划 | extractPlannerPlan | 反向 | P0 | 普通回复 | 1. 输入 parser | 返回 null | function | null | [可自动化] |
| TC-HUB-006 | TaskPlan 字段缺失时不渲染无效 DAG | TaskPlan | 参数 | P1 | mock 缺 `tasks` | 1. 注入 planner 输出 | 前端忽略或显示错误，不崩溃 | plan_result | 无非法节点 | [可自动化] |
| TC-HUB-007 | DAG 拓扑排序独立任务同层并行 | TaskQueue/topologicalSort | 正向 | P0 | tasks 无 dependsOn | 1. 调 topologicalSort | 返回单层全部任务 | function | layer count=1 | [可自动化] |
| TC-HUB-008 | DAG 菱形依赖排序正确 | TaskQueue/topologicalSort | 状态 | P0 | A->B/C->D | 1. 调排序 | D 在 B/C 完成后 | function | 层次正确 | [可自动化] |
| TC-HUB-009 | 循环依赖被拒绝 | TaskDAG/TaskQueue | 反向 | P0 | 构造 A depends B, B depends A | 1. 确认执行 | 返回错误，不进入分发 | confirm_plan | 无 task_assigned | [可自动化] |
| TC-HUB-010 | TaskDAG 节点状态 waiting/running/done/failed 正确变更 | TaskDAG | 状态 | P0 | 有计划任务 | 1. 确认执行；2. 监听事件 | 节点状态随任务事件变化 | `task_*` | UI 状态一致 | [可自动化] |
| TC-HUB-011 | 用户确认计划后开始执行 | ConfirmationPanel | 正向 | P0 | 已显示 DAG | 1. 点击确认 | 广播 plan_executing 并分配任务 | `confirm_plan` | `plan_executing` | [可自动化] |
| TC-HUB-012 | 用户取消计划不执行任务 | ConfirmationPanel | 反向 | P1 | 已显示 DAG | 1. 点击取消 | 不触发 task_assigned | UI/WS | 队列为空 | [可自动化] |
| TC-HUB-013 | 修改任务描述后按新描述执行 | Task modification | 正向 | P0 | 已显示 DAG | 1. 编辑任务描述；2. 确认执行 | Agent 收到修改后的 description | `modify_task` | prompt 含新描述 | [可自动化] |
| TC-HUB-014 | 修改不存在任务返回可理解错误 | Task modification | 反向 | P2 | 已有 plan | 1. 修改不存在 taskId | 不影响已有任务 | `modify_task` | 错误或 no-op | [可自动化] |
| TC-HUB-015 | 失败任务可单独重试 | retry_task | 正向 | P0 | 某任务 failed | 1. 点击 retry；2. 监听任务 | 任务重新入队并执行 | `retry_task` | task_assigned 再次出现 | [可自动化] |
| TC-HUB-016 | retry_task 缺少完整 task 数据被拒绝 | retry_task | 参数 | P1 | failed task | 1. 发送仅 planId/taskId | 返回需要完整 task 数据 | WS | `stream_error` | [可自动化] |
| TC-HUB-017 | 任务按 agentType 路由到群内 Agent | dispatchTasksToAgents | 正向 | P0 | group 有 Code/Review | 1. 计划含 CodeAgent/ReviewAgent | 分配给对应 Agent | `task_assigned` | agentName 匹配 | [可自动化] |
| TC-HUB-018 | 同类型多个 Agent 选择队列最短 | dispatchTasksToAgents | 并发 | P1 | 两个 code 类型 Agent | 1. 连续提交多个 Code 任务 | 负载较低 Agent 优先接收 | `task_assigned` | 队列均衡 | [可自动化] |
| TC-HUB-019 | Agent 不在线时自动启动 REPL 执行任务 | startTaskAgent | 正向 | P0 | 对应 Agent 未启动 | 1. 确认计划 | 启动 provider 并执行任务 | `task_assigned` | provider alive | [可自动化] |
| TC-HUB-020 | Agent 已在线时复用 REPL sendPrompt | processNextInQueue | 正向 | P0 | Agent REPL alive | 1. 提交第二个任务 | 不新建进程，sendPrompt 执行 | provider | process id 不变 | [可自动化] |
| TC-HUB-021 | REPL done 后自动执行同 Agent 队列下一任务 | processNextInQueue | 状态 | P0 | Agent 队列有 2 个任务 | 1. 完成第一个 | 第二个自动开始 | `task_completed`/assigned | 顺序正确 | [可自动化] |
| TC-HUB-022 | 无精确 Agent 时 findClosestAgent 前缀兜底 | Agent 缺失 | 正向 | P1 | plan 指定 `Code` | 1. 确认执行 | 兜底到 code-agent，并通知 | `agent_missing` | fallbackAgent=code-agent | [可自动化] |
| TC-HUB-023 | 无可兜底 Agent 时提示建议创建 | Agent 缺失 | 反向 | P1 | 移除匹配 Agent | 1. plan 指定 DBAgent | 推送 agent_missing，含 suggestedAgent | `agent_missing` | 不执行该任务 | [可自动化] |
| TC-HUB-024 | Planner prompt 注入当前群成员 | Planner | 正向 | P1 | group 有自定义 Agent | 1. 触发规划；2. 检查 prompt 或输出 | 计划只使用群成员或列 missingAgents | prompt | 成员列表准确 | [可自动化] |
| TC-HUB-025 | 复杂博客系统拆解为前后端/DB/审查/部署 DAG | 复杂任务 | 场景 | P0 | group 含 Code/Review/DevOps/Planner | 1. 输入“搭建博客系统并部署”；2. 确认 | 生成含依赖 DAG；多个 Agent 协作完成 | plan_result + task_* | 后端/API/前端/部署任务完整 | [需人工] |
| TC-HUB-026 | 复杂 Bug 修复任务先复现再修复再审查 | 复杂任务 | 场景 | P0 | 有错误日志和项目 | 1. 输入日志并要求 plan；2. 确认 | DAG 含复现、定位、修复、测试、Review | plan_result | Review 在修复后执行 | [需人工] |
| TC-HUB-027 | 多 Agent 并行开发同一项目后汇总报告 | 复杂任务 | 场景 | P1 | group session | 1. 执行多任务计划；2. 等全部完成 | 发送 plan_summary，含完成/失败和文件清单 | `plan_summary` | 统计准确 | [可自动化] |
| TC-HUB-028 | 兄弟任务失败不阻塞无依赖任务 | 失败降级 | 状态 | P0 | DAG A/B 独立，A fail | 1. 执行计划 | B 继续执行，A failed | `task_failed` | 无依赖任务完成 | [可自动化] |
| TC-HUB-029 | 依赖失败时后继任务阻塞 | 失败降级 | 状态 | P0 | A->B，A fail | 1. 执行计划 | B 不执行或标记 blocked | task state | 无 B task_assigned | [可自动化] |
| TC-HUB-030 | 重试耗尽后保留错误日志 | 失败降级 | 异常 | P1 | 设置重试次数 | 1. 让任务持续失败 | 保留最后错误和任务上下文 | task_failed | 日志可展开 | [可自动化] |
| TC-HUB-031 | 重新规划入口收集失败上下文 | Replan | 场景 | P2 | failed task | 1. 点击“让 Main Agent 重新规划” | 构造包含错误、文件树、前置产出的 prompt | `replan_failed_task` | 上下文完整 | [可自动化] |
| TC-HUB-032 | 顺序编排模式按 mentions 顺序执行 | orchestrationMode | 正向 | P0 | group session | 1. 发送两个 mentions + sequential | 第二个在第一个 done 后启动 | WS | 无并行运行 | [可自动化] |
| TC-HUB-033 | parallel 模式多个 mentions 同时执行 | orchestrationMode | 正向 | P0 | group session | 1. 发送两个 mentions + parallel | 两个 Agent 同时 running | WS | running 时间重叠 | [可自动化] |
| TC-HUB-034 | TaskDAG 拖拽新增依赖后影响执行顺序 | 交互 DAG | 功能 | P1 | 可交互 DAG | 1. 拖线 A->B；2. 确认 | B 等 A 完成再执行 | UI/WS | 依赖边生效 | [可自动化] |
| TC-HUB-035 | TaskDAG 右键删除任务后不执行该任务 | 交互 DAG | 功能 | P1 | 可交互 DAG | 1. 右键删除节点；2. 确认 | 删除任务不进入队列，依赖重算 | UI/WS | 无该 taskId | [可自动化] |

## 工作区、Diff、版本历史与冲突

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-DIFF-001 | 空工作区首次记录版本会初始化 git baseline | WorkspaceManager | 正向 | P0 | 新沙箱空目录 | 1. 调 recordVersion；2. 查看 `.git` | git 仓库初始化，baseline 可 diff | function/fs | `.git` 存在 | [可自动化] |
| TC-DIFF-002 | Agent 执行前自动记录 before version | diffBroadcast | 正向 | P0 | 发送修改文件任务 | 1. 启动 Agent；2. 检查 version | before version 存在 | WS/task | versionId 记录 | [可自动化] |
| TC-DIFF-003 | 用户文件变更生成 DiffCard | DiffCard | 正向 | P0 | Agent 修改 `src/app.ts` | 1. 等 Agent done | 推送 diff_summary/DiffCard | WS | files 包含 app.ts | [可自动化] |
| TC-DIFF-004 | Agent 内部文件变更不生成 DiffCard | 文件过滤 | 正向 | P0 | Agent 仅写 `_prompt_*` | 1. 等 Agent done | 不推送用户可见 diff | WS | 无 DiffCard | [可自动化] |
| TC-DIFF-005 | `.claude/` 和 `_agent_*/` 被过滤 | 文件过滤 | 边界 | P1 | Agent 写内部目录 | 1. 修改 `.claude/x` 和 `_agent_code/y` | 不出现在 diff | getChanges | filtered | [可自动化] |
| TC-DIFF-006 | Monaco DiffViewer 展示并排差异 | DiffViewer | UI | P1 | 有 diff 文件 | 1. 展开 DiffCard | 左旧右新，hunk 正确 | UI | diff 内容一致 | [需人工] |
| TC-DIFF-007 | DiffCard 默认折叠且可关闭 | DiffCard | UI | P2 | 收到 diff card | 1. 观察默认；2. 点击关闭 | 默认摘要可见，关闭后隐藏 | UI | 不删除实际文件 | [可自动化] |
| TC-DIFF-008 | 接受文件修改保留当前版本 | `/api/diff/accept` | 正向 | P0 | 有 diff | 1. 点击 accept；2. 读取文件 | 当前修改保留，卡片状态 accepted | API/UI | 文件内容为新版本 | [可自动化] |
| TC-DIFF-009 | 拒绝文件修改回退到快照 | `/api/diff/reject` | 正向 | P0 | 有 diff | 1. 点击 reject；2. 读取文件 | 文件恢复到 before version | API/UI | 内容等于快照 | [可自动化] |
| TC-DIFF-010 | accept/reject 跨用户被拒绝 | `/api/diff/*` | 权限 | P0 | userA diff，userB token | 1. userB 调 accept | 拒绝访问，不改文件 | API | 403/404 | [可自动化] |
| TC-DIFF-011 | 大文件 diff 可折叠或限制渲染 | DiffViewer | 边界 | P1 | 生成 >1MB diff | 1. 展开查看 | UI 不崩溃，提示或虚拟渲染 | UI | 页面可操作 | [需人工] |
| TC-DIFF-012 | 二进制文件变更显示为不可文本 diff | Diff API | 边界 | P2 | Agent 修改 png | 1. 生成 diff | 显示二进制变更摘要，不乱码 | API/UI | 不抛异常 | [可自动化] |
| TC-DIFF-013 | 版本时间线记录每次 Agent 修改 | VersionTimeline | 正向 | P0 | 连续两次修改同文件 | 1. 等两轮 done；2. 查看 timeline | 有两个版本节点，含 agent 和摘要 | UI/API | count=2 | [可自动化] |
| TC-DIFF-014 | 任意两个版本可并排 Diff | VersionTimeline | 正向 | P1 | 至少 3 个版本 | 1. 选择 v1/v3 | 展示 v1->v3 差异 | UI/API | diff 正确 | [可自动化] |
| TC-DIFF-015 | 回退到历史版本后文件内容正确 | VersionTimeline | 状态 | P0 | 有历史版本 | 1. 选择旧版本回退 | 工作区内容恢复旧版本并记录操作 | API/fs | hash 匹配 | [可自动化] |
| TC-DIFF-016 | 回退版本后再次 Agent 修改生成新分支节点 | VersionTimeline | 状态 | P2 | 已回退 | 1. 再让 Agent 修改 | 新版本节点追加，历史可追溯 | UI/API | timeline 完整 | [可自动化] |
| TC-DIFF-017 | 两个 Agent 修改同一文件触发 conflict_detected | 冲突检测 | 并发 | P0 | group session | 1. 并行让两个 Agent 改同一文件 | 推送冲突消息，列出 agents | `conflict_detected` | filePath/agents 正确 | [可自动化] |
| TC-DIFF-018 | 两个 Agent 修改不同文件不报冲突 | 冲突检测 | 正向 | P0 | group session | 1. 并行改不同文件 | 不触发冲突 | WS | 无 conflict_detected | [可自动化] |
| TC-DIFF-019 | 冲突文件在 Diff 中橙色高亮 | DiffViewer | UI | P1 | 已有冲突 | 1. 打开 diff | 冲突区域高亮并提示来源 Agent | UI | 高亮可见 | [需人工] |
| TC-DIFF-020 | 冲突裁决选择 Agent A 版本 | ConflictResolver | 状态 | P1 | 同文件冲突 | 1. 选择保留 A；2. 保存 | 文件内容为 A 版本，冲突清除 | UI/API | hash=A | [可自动化] |
| TC-DIFF-021 | 冲突裁决取消不改变文件 | ConflictResolver | 反向 | P2 | 同文件冲突 | 1. 打开裁决；2. 取消 | 文件保持当前状态，冲突仍可见 | UI/API | hash 不变 | [可自动化] |
| TC-DIFF-022 | FileTree 展示工作区目录并可刷新 | FileTree/API | 正向 | P1 | 沙箱有文件 | 1. 打开 Files 标签；2. 刷新 | 文件树结构正确 | `/api/workspace` | 路径/类型正确 | [可自动化] |
| TC-DIFF-023 | FileTree 禁止越权读取宿主路径 | Workspace API | 安全 | P0 | 已登录 | 1. 请求 `../../.env` | 拒绝路径穿越 | API | 400/403 | [可自动化] |
| TC-DIFF-024 | Workspace accept/reject 操作失败时给出错误并保持一致 | Diff API | 异常 | P1 | mock 文件锁定 | 1. 点击 reject | 显示失败，文件不半更新 | API/UI | 原子性保持 | [可自动化] |
| TC-DIFF-025 | 关闭 DiffCard 后历史版本仍可查看 | DiffCard/Version | 状态 | P2 | 有 diff card | 1. 关闭卡片；2. 打开版本历史 | 关闭仅隐藏通知，不删除版本 | UI | timeline 仍有记录 | [可自动化] |

## 产物预览、文档/PPT/代码二次交互

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-PREV-001 | dev server 端口检测后生成预览 URL | Preview API | 正向 | P0 | 沙箱内启动 Vite | 1. 打开 Preview 标签；2. 请求端口检测 | 返回可访问 preview URL | `/api/preview` | iframe 200 | [可自动化] |
| TC-PREV-002 | 无 dev server 时 Preview 标签显示空态 | PreviewFrame | 边界 | P1 | 沙箱无服务 | 1. 打开 Preview | 显示未检测到服务，不报错 | UI/API | 无 iframe 失败噪音 | [可自动化] |
| TC-PREV-003 | 预览代理转发 HTTP 请求 | Preview proxy | 正向 | P0 | dev server running | 1. 请求 `/api/preview/.../proxy` | 返回 dev server HTML | API | 200 text/html | [可自动化] |
| TC-PREV-004 | 预览代理拒绝非法 session | Preview proxy | 权限 | P0 | userB token | 1. 访问 userA preview | 拒绝访问 | API | 403/404 | [可自动化] |
| TC-PREV-005 | HMR WebSocket 不支持时预览仍可手动刷新 | PreviewFrame | 降级 | P2 | Vite HMR 受限 | 1. 修改代码；2. 手动刷新 iframe | 页面可刷新看到新内容 | UI | 不阻塞主流程 | [需人工] |
| TC-PREV-006 | 截图对比卡片展示修改前后图片 | ScreenshotComparisonCard | 正向 | P1 | 有 before/after 截图 | 1. 触发截图对比 | 卡片展示两张图和说明 | UI | 图片加载成功 | [需人工] |
| TC-PREV-007 | Markdown 表格正确渲染 | MessageBubble | 正向 | P0 | Agent 输出 Markdown 表格 | 1. 发送生成表格文档任务 | 表格而非纯文本显示 | UI | th/td 渲染 | [可自动化] |
| TC-PREV-008 | Markdown 链接安全过滤 javascript | Markdown renderer | 安全 | P0 | Agent 输出恶意链接 | 1. 渲染 `[x](javascript:alert(1))` | 链接被禁用或转义 | UI | 无脚本执行 | [可自动化] |
| TC-PREV-009 | Markdown image data URL 仅允许安全图片 | Markdown renderer | 安全 | P1 | 恶意 data URL | 1. 渲染 data:text/html | 不执行 HTML | UI | URL 被过滤 | [可自动化] |
| TC-PREV-010 | 文档段落选择后构造引用 prompt | 文档引用 | 正向 | P0 | 消息含 Markdown 段落 | 1. 选中段落；2. 点击让 Agent 修改 | prompt 含选中内容和上下文 | UI/WS | 引用准确 | [可自动化] |
| TC-PREV-011 | 只选部分段落时 Agent 增量处理范围正确 | 文档引用 | 场景 | P1 | 长文档 | 1. 选第 3 段；2. 要求润色 | 只改目标段或明确说明影响范围 | WS/Diff | 非目标段不变 | [需人工] |
| TC-PREV-012 | PPTX 上传后生成内联浏览卡片 | PPTViewer | 正向 | P0 | 准备 pptx 文件 | 1. 点击附件上传；2. 观察消息 | PPT 卡片出现，可翻页 | upload/UI | 页数正确 | [可自动化] |
| TC-PREV-013 | PPT 缩略图导航定位正确 | PPTViewer | UI | P2 | PPT 多页 | 1. 点击第 N 页缩略图 | 主视图跳到第 N 页 | UI | 页码一致 | [需人工] |
| TC-PREV-014 | PPT 导出 PDF | PPTViewer | 正向 | P1 | PPT 卡片打开 | 1. 点击导出 PDF/打印 | 触发 PDF 导出流程 | UI | 文件/打印可用 | [需人工] |
| TC-PREV-015 | 上传不支持文件类型给出提示 | 文件上传 | 反向 | P1 | 准备 exe 文件 | 1. 上传文件 | 拒绝或提示不支持，不写入危险路径 | UI/API | 错误提示 | [可自动化] |
| TC-PREV-016 | 多文件上传全部落入当前沙箱 workspace | 文件上传 | 正向 | P1 | 准备 md/png/pptx | 1. 批量上传；2. 查看 FileTree | 文件存在且路径安全 | API/fs | 数量一致 | [可自动化] |
| TC-PREV-017 | 代码块内联编辑后可提交给 Agent | Code editor | 正向 | P0 | Agent 输出代码块 | 1. 编辑代码块；2. 点击让 Agent 修改 | 构造含编辑后代码的 prompt | UI/WS | Agent 收到新代码 | [可自动化] |
| TC-PREV-018 | 代码编辑取消不产生消息或文件变更 | Code editor | 反向 | P2 | 编辑中 | 1. 修改代码；2. 点击取消 | UI 恢复，未发送 WS | UI | 无新消息 | [可自动化] |
| TC-PREV-019 | 产物二次交互生成并排对比 | 二次交互 | 场景 | P1 | 有原产物 | 1. 选中内容让 Agent 修改 | 展示新旧对比或 DiffCard | UI/WS | 变化可追溯 | [需人工] |
| TC-PREV-020 | IM 范式下预览不常驻聊天底部 | ChatView | UI | P2 | 打开聊天页 | 1. 检查布局 | Preview 位于右侧标签，不挤压输入区 | UI | 无底部常驻工具栏 | [需人工] |

## 部署、测试、安全检查与审查报告

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-OPS-001 | `/deploy docker` 触发部署流程 | 部署 | 正向 | P0 | 沙箱有可部署项目 | 1. 输入 `/deploy docker` | 发送 deploy_to_platform，显示 DeployCard | WS | Building 状态出现 | [可自动化] |
| TC-OPS-002 | `/deploy vercel` 选择 Vercel 目标 | 部署 | 正向 | P1 | 配置 Vercel 凭据 | 1. 输入 `/deploy vercel` | 使用 Vercel 流程并推送状态 | WS/API | target=vercel | [可自动化] |
| TC-OPS-003 | `/deploy cloudflare` 选择 Cloudflare Pages | 部署 | 正向 | P1 | 配置 Cloudflare 凭据 | 1. 输入命令 | 使用 Cloudflare 流程 | WS/API | target=cloudflare | [可自动化] |
| TC-OPS-004 | 非法部署目标被拒绝 | 部署 | 反向 | P0 | 已连接 | 1. 输入 `/deploy unknown` | 返回错误，不执行构建 | WS/API | failed/error | [可自动化] |
| TC-OPS-005 | DeployCard 状态 Building→Deploying→Success | DeployCard | 状态 | P0 | 部署可成功 | 1. 触发部署；2. 监听状态 | 状态按顺序更新，含 URL/耗时/SHA | `deployment_status` | 顺序正确 | [可自动化] |
| TC-OPS-006 | 部署失败触发自动回滚 | 部署 | 异常 | P0 | mock deploy 失败且有上个版本 | 1. 触发部署；2. 让 Deploy 失败 | 回滚到上个成功版本，卡片显示原因 | API/WS | rollback called | [可自动化] |
| TC-OPS-007 | DevOpsAgent 生成 Dockerfile 和 compose | DevOpsAgent | 正向 | P1 | 项目无部署配置 | 1. 让 DevOpsAgent 准备部署 | 生成配置文件并进入 DiffCard | WS/Diff | 文件存在 | [可自动化] |
| TC-OPS-008 | 部署日志实时推送且不泄漏 secret | 部署安全 | 安全 | P0 | 部署含 env | 1. 触发部署；2. 查看日志 | 日志脱敏，状态持续更新 | WS | 无 SECRET/TOKEN 明文 | [可自动化] |
| TC-OPS-009 | TestAgent 执行测试生成 TestReportCard | 测试报告 | 正向 | P0 | 项目有测试命令 | 1. 让 TestAgent 运行测试 | 卡片显示总数、通过、失败、耗时 | `test_report` | total/pass/fail 正确 | [可自动化] |
| TC-OPS-010 | 测试失败堆栈被截断展示 | TestReportCard | 边界 | P1 | 构造长失败堆栈 | 1. 运行失败测试 | 展示摘要和可展开详情，不撑爆 UI | UI | 长度受控 | [可自动化] |
| TC-OPS-011 | “让 Agent 修复”从失败测试触发修复任务 | TestReportCard | 场景 | P1 | 有 failed test report | 1. 点击修复 | 构造包含失败堆栈的 prompt 给 CodeAgent | UI/WS | 新任务创建 | [可自动化] |
| TC-OPS-012 | npm audit JSON 解析为严重程度分组 | 安全检查 | 正向 | P0 | 准备 audit JSON | 1. 运行 DepsAgent 或 parser | critical/high/moderate/low 分组正确 | `security_report` | CVE 识别 | [可自动化] |
| TC-OPS-013 | SecurityCard CVE 链接可点击 | SecurityCard | UI | P2 | 有漏洞报告 | 1. 展开卡片；2. 点击 CVE | 打开安全详情链接 | UI | URL 合法 | [需人工] |
| TC-OPS-014 | 一键升级依赖后重新生成安全报告 | 安全检查 | 场景 | P1 | 有可升级漏洞 | 1. 点击全部升级；2. 重新 audit | 漏洞减少或显示无法升级原因 | WS/API | 报告更新 | [可自动化] |
| TC-OPS-015 | ReviewAgent 输出结构化审查报告 | 审查报告 | 正向 | P0 | 有代码变更 | 1. 让 ReviewAgent 审查 | ReviewCard 展示高危/警告/建议 | `review_report` | findings 分级 | [可自动化] |
| TC-OPS-016 | ReviewCard 点击问题跳到 Diff 行 | ReviewCard | UI | P1 | 有 file:line finding | 1. 点击 finding | DiffViewer 定位对应文件和行 | UI | 行号匹配 | [可自动化] |
| TC-OPS-017 | Review finding 可标记已修复 | ReviewCard | 状态 | P2 | 有 review report | 1. 点击已修复 | finding 状态更新并持久化 | UI/API | 状态可恢复 | [可自动化] |
| TC-OPS-018 | Review finding 可忽略且记录原因 | ReviewCard | 状态 | P2 | 有 finding | 1. 点击忽略并输入原因 | 状态 ignored，原因可回看 | UI/API | audit trail 存在 | [可自动化] |
| TC-OPS-019 | 历史消息中可回看部署/测试/审查卡片 | 消息持久化 | 状态 | P1 | 已生成多个卡片 | 1. 刷新页面；2. 打开历史 | 卡片数据恢复，不只剩纯文本 | API/UI | card payload 存在 | [可自动化] |
| TC-OPS-020 | 扩展卡片解析失败降级为普通消息 | ArtifactTools | 异常 | P1 | Agent 输出格式损坏 | 1. 发送 malformed report | 不崩溃，显示原始输出或错误提示 | parser/UI | 无 JS error | [可自动化] |

## 非功能、性能、可靠性与复杂端到端

| 用例编号 | 标题 | 模块/接口 | 类型 | 优先级 | 前置条件 | 测试步骤 | 预期结果 | 请求/事件 | 状态码/断言 | 自动化 |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-NFR-001 | 新用户 2 分钟内完成首次 Agent 对话 | 用户旅程 | 性能/场景 | P0 | 干净浏览器和合法 OAuth | 1. 登录；2. 建会话；3. 发消息；4. 收到首个响应 | 总耗时 ≤2 分钟 | E2E | 计时达标 | [需人工] |
| TC-NFR-002 | 消息首字节时间小于 1 秒 | WS stream | 性能 | P0 | Agent mock 快速输出 | 1. 发送消息；2. 记录到首个 chunk | TTFB <1s | WS | p95 <1s | [可自动化] |
| TC-NFR-003 | 页面首屏加载小于 2 秒 | 前端 | 性能 | P1 | 本地生产构建 | 1. 打开首页；2. 采集性能指标 | LCP/首屏 <2s | browser perf | 达标 | [可自动化] |
| TC-NFR-004 | 打字机流式渲染保持 60fps | MessageBubble | 性能 | P2 | 高频 chunk mock | 1. 发送大量 chunks；2. 采集 FPS | 无明显卡顿，平均接近 60fps | browser perf | dropped frames 可控 | [需人工] |
| TC-NFR-005 | 10 个以上 Agent 在线时状态面板可用 | AgentStatusPanel | 容量 | P1 | 创建 10+ Agent group | 1. 同时显示/部分运行 | 面板可滚动、计数准确、无布局破裂 | UI/WS | 无 JS error | [需人工] |
| TC-NFR-006 | 权限确认卡片 3 秒内推送 | 权限代理 | 性能 | P0 | Trust OFF | 1. 触发权限请求；2. 计时 UI 出现 | <=3s 可见 | WS/UI | p95 <=3s | [可自动化] |
| TC-NFR-007 | 产物预览 5 秒内完成渲染 | PreviewFrame | 性能 | P1 | dev server 已启动 | 1. 打开 Preview；2. 计时 iframe load | <=5s 渲染 | UI/API | load event <=5s | [可自动化] |
| TC-NFR-008 | 空库/1w/10w 会话列表查询性能 | `/api/sessions` | 性能 | P1 | 准备不同数据量 | 1. 分别请求列表；2. 记录 RT | 查询耗时随数据量可控 | GET | p95 满足内部阈值 | [可自动化] |
| TC-NFR-009 | 100 并发 WebSocket 连接稳定 | `/ws` | 并发 | P1 | 压测环境 | 1. 建 100 WS；2. 保持并发发送 ping/chat | 无大量断线，错误率低 | WS | error rate <1% | [可自动化] |
| TC-NFR-010 | 多会话并行任务沙箱资源不泄漏 | SandboxManager | 稳定性 | P1 | 压测环境 | 1. 创建/删除 50 会话；2. 检查容器/目录 | 容器和临时目录被清理 | Docker/fs | 无明显泄漏 | [可自动化] |
| TC-NFR-011 | Redis 不可用时优雅降级或明确失败 | Redis/BullMQ | 可靠性 | P1 | 停止 Redis | 1. 执行会话/任务相关操作 | 核心聊天可用或错误明确 | API/WS | 无进程崩溃 | [可自动化] |
| TC-NFR-012 | PostgreSQL 短暂断开后恢复 | DB | 可靠性 | P0 | 可控制 DB | 1. 断开 DB；2. 请求接口；3. 恢复 | 断开时错误明确，恢复后可继续 | API | 无永久坏状态 | [可自动化] |
| TC-NFR-013 | 预览 iframe 隔离 XSS | Preview security | 安全 | P0 | 沙箱产物含恶意脚本 | 1. 打开预览；2. 尝试访问父窗口 | iframe sandbox/CSP 阻止越界 | UI/security | parent 不可访问 | [可自动化] |
| TC-NFR-014 | Docker 沙箱无法读取宿主敏感文件 | Sandbox security | 安全 | P0 | 沙箱运行 | 1. Agent 尝试读宿主 `/etc/shadow` 或项目外 `.env` | 读取失败或仅能访问挂载工作区 | Docker | 权限拒绝 | [可自动化] |
| TC-NFR-015 | API 错误响应不包含堆栈和密钥 | API security | 安全 | P0 | mock 抛异常 | 1. 请求异常接口 | 返回通用错误，不泄漏 stack/secret | API | 无敏感内容 | [可自动化] |
| TC-NFR-016 | 复杂全栈原型从需求到部署闭环 | E2E 复杂项目 | 场景 | P0 | group 含 Planner/Code/Review/DevOps/Test | 1. 输入“实现带登录的任务管理 SaaS 并部署”；2. 确认 DAG；3. 等执行；4. 预览；5. 部署 | 任务拆解、并行开发、测试、审查、预览、部署全链路可走通 | UI/WS/API | 产物可访问，报告完整 | [需人工] |
| TC-NFR-017 | 复杂多 Agent 冲突裁决后继续部署 | E2E 复杂项目 | 场景 | P0 | 两 Agent 会修改同一文件 | 1. 执行复杂计划；2. 触发冲突；3. 裁决；4. 继续测试部署 | 冲突不破坏流程，裁决后后续任务使用正确版本 | UI/WS/Diff | 部署成功或明确失败 | [需人工] |
| TC-NFR-018 | 大型代码库任务文件树上下文不超限 | Planner/TaskQueue | 边界 | P1 | 准备大型仓库 | 1. 触发规划和任务分发 | prompt 注入摘要/文件树受控，不超过上下文预算 | prompt | 无 provider context error | [可自动化] |
| TC-NFR-019 | Provider CLI 格式变化时解析层失败可诊断 | Provider compatibility | 风险 | P1 | mock 新格式事件 | 1. 输入未知事件结构 | 不崩溃，记录 unknown/diagnostic | parser/log | 错误可定位 | [可自动化] |
| TC-NFR-020 | 长时间 8 小时混合场景稳定性 | 全系统 | 稳定性 | P2 | 压测环境和监控 | 1. 混合登录、聊天、规划、预览、部署 8h；2. 监控资源 | 无内存/连接/容器泄漏，错误率在阈值内 | perf run | RSS/FD/containers 稳定 | [可自动化] |

## 自检清单

- 每个核心功能/接口至少包含一条正向 P0/P1 用例。
- 认证、鉴权、跨用户、路径穿越、XSS、secret 泄漏、生产部署确认均有安全类用例。
- 参数缺失、非法枚举、空值、超长输入、大文件、大数据量、并发上限均有边界/异常类用例。
- 覆盖单 Agent、群聊多 Agent、Planner DAG、任务确认/修改/重试、REPL 复用、缺失 Agent、失败降级、冲突裁决等复杂协作场景。
- 覆盖 Diff、版本历史、预览、文档/PPT/代码二次交互、部署、测试报告、安全检查、审查报告等 Phase 4 闭环能力。
- 自动化候选已标注；视觉、人工判断或长时间稳定性用例标为 `[需人工]`。
