# 风险评估与上线建议

## 当前测试覆盖情况

- TESTCASES.md 解析总数：230
- 通过：96
- 失败：0
- 阻塞：92
- 未执行：42
- 已修复缺陷：14
- 已通过测试模式缓解：0
- 未修复/待确认缺陷：0

## 高风险模块

- 真实 Agent CLI 执行链路：流式、Planner、多 Agent、stop 已有实测证据；permission/tool/subagent/冲突链路已由 test provider 完成确定性 WS/UI 回归；真实 Claude Code provider 的 permission_request、Allow、Deny、Timeout 和 UI 权限卡也已通过回归。Planner DAG 确认执行已由 test provider 完成 WS/UI 确定性回归，真实 Claude 多 Agent 长任务仍未作为生产通过依据。
- GitHub OAuth：白名单账号 `JohnSiegfried` 已完成真实授权并通过；非白名单账号 `XTC2233` 已完成真实授权拒绝验证，callback 返回 403，DB 未创建用户。
- 部署：Docker/Vercel/Cloudflare 成功部署、回滚仍需真实项目和凭据；provider 凭据不再落 workspace env 文件，日志明文暴露问题已回归。
- 长时稳定性与性能：test provider 下 30 分钟空闲 WS、100 并发 WS、50 会话沙箱清理、1w/10w 会话列表性能已通过；8 小时混合场景、真实 provider 长稳和部署链路仍未执行。
- 文件上传/PPT/视觉 Diff：多项为人工或缺少自动断言基线。

## 权限风险

已验证部分 JWT、WS 鉴权关闭码、空白消息拒绝、部署目标校验、真实 OAuth 白名单/非白名单账号，test provider 下的权限卡片/允许/拒绝/无效 permissionId，以及真实 Claude provider 下的 Allow/Deny/Timeout 权限三态。未完整验证跨用户 session/chat/diff/preview/workspace 全链路。真实 Agent 可读取工作区 `_env.sh` 的风险已修复并回归；模型 provider 凭据仍会作为容器进程环境提供给 Claude CLI，后续如开放任意 shell/env 输出，需要凭据代理或短期令牌方案。

## 数据一致性风险

会话删除、消息创建、lastMessage 截断、Agent 分配、stream_end 后 DB 一致性已修复并回归；Planner DAG 的跨 Agent 依赖等待、失败阻塞、retry 后恢复 blocked 子树与 Plan Summary、重复 confirm 去重、task messageId 跨计划唯一性已修复并回归；test provider 已验证两个 Agent 修改同一文件触发 `conflict_detected`，但冲突裁决 UI/保存路径仍未完整跑通。

## 兼容性风险

本轮仅验证 Chromium 和本地 1280px+ 场景；未覆盖移动端、其他浏览器和完整暗色主题视觉走查。

## 性能或稳定性风险

已执行 31 分 31 秒确定性长稳基线：100 并发 WS 30 分钟错误率 0%，空闲 WS 30 分钟后可继续 chat，10w 会话列表 p95 1256.32ms，50 会话沙箱清理无遗留容器/目录。仍未执行 8 小时混合稳定性、真实 Claude provider 长稳、真实部署压测，不建议据此声称生产全量性能达标。

## 上线建议

结论：不通过，不建议直接生产上线。  
上线前必须补齐：部署成功/回滚、8 小时混合稳定性压测、跨用户权限全链路、真实 Claude 多 Agent DAG 长任务 smoke，以及模型 provider 凭据的长期隔离方案。
可以后续优化：PPT/文档二次交互、视觉 Diff 基线、更多浏览器兼容性。
