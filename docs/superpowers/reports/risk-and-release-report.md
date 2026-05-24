# 风险评估与上线建议

## 当前测试覆盖情况

- TESTCASES.md 解析总数：230
- 通过：76
- 失败：0
- 阻塞：111
- 未执行：43
- 已修复缺陷：8
- 已通过测试模式缓解：1
- 未修复/待确认缺陷：2

## 高风险模块

- 真实 Agent CLI 执行链路：流式、Planner、多 Agent、stop 已有实测证据；permission/tool/subagent/冲突链路已由 test provider 完成确定性 WS/UI 回归，但真实 Claude Code provider 的 permission_request 能力仍需 PTY/remote-control 或替代通道。
- GitHub OAuth：白名单账号 `JohnSiegfried` 已完成真实授权并通过；非白名单账号 `hengming0820` 按用户要求暂不执行，拒绝链路仍待验证。
- 部署：Docker/Vercel/Cloudflare 成功部署、回滚、日志脱敏仍需真实项目和凭据。
- 长时稳定性与性能：30 分钟、8 小时、100 WS、1w/10w 数据量用例未完整执行。
- 文件上传/PPT/视觉 Diff：多项为人工或缺少自动断言基线。

## 权限风险

已验证部分 JWT、WS 鉴权关闭码、空白消息拒绝、部署目标校验、真实 OAuth 白名单账号，以及 test provider 下的权限卡片/允许/拒绝/无效 permissionId；未完整验证跨用户 session/chat/diff/preview/workspace 全链路，也未验证真实 OAuth 非白名单拒绝链路。真实 Agent 可读取工作区 `_env.sh` 的风险仍需修复或架构确认。

## 数据一致性风险

会话删除、消息创建、lastMessage 截断、Agent 分配、stream_end 后 DB 一致性已修复并回归；test provider 已验证两个 Agent 修改同一文件触发 `conflict_detected`，但冲突裁决 UI/保存路径仍未完整跑通。

## 兼容性风险

本轮仅验证 Chromium 和本地 1280px+ 场景；未覆盖移动端、其他浏览器和完整暗色主题视觉走查。

## 性能或稳定性风险

未执行 8 小时混合稳定性、100 并发 WS、1w/10w 会话列表完整性能压测；不建议据此声称性能达标。

## 上线建议

结论：不通过，不建议直接生产上线。  
上线前必须补齐：真实 OAuth 非白名单拒绝验证、真实 Claude provider 权限代理可响应通道或明确只支持 test provider 回归、凭据文件/日志脱敏、Planner DAG 确认执行、部署成功/回滚、长时稳定性压测。  
可以后续优化：PPT/文档二次交互、视觉 Diff 基线、更多浏览器兼容性。
