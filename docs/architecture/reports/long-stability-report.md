# 长时稳定性压测报告

## 测试概况

- 测试时间：2026-05-24 15:38:21 至 16:09:52
- 测试环境：本地开发环境，API `http://localhost:3000`，Web `http://localhost:5173`
- Agent Provider：`AGENTHUB_AGENT_PROVIDER=test`
- 测试范围：`TC-WS-025`、`TC-NFR-008`、`TC-NFR-009`、`TC-NFR-010`
- 执行时长：31 分 31 秒
- 原始证据：`docs/superpowers/reports/evidence/long-stability-evidence.json`
- 页面健康截图：`docs/superpowers/reports/evidence/long-stability-login.png`

## 环境检查

| 检查项 | 结果 |
|---|---|
| `/api/auth/me` 无 Token | 401，符合预期 |
| `/login` 页面 | 200，Playwright 可打开 |
| 浏览器控制台错误 | 0 |
| Playwright 请求失败 | 0 |
| 压测前 sandbox 容器 | 0 |
| 压测前 `.sandboxes` 目录 | 0 |
| 压测后 sandbox 容器 | 0 |
| 压测后 `.sandboxes` 目录 | 0 |
| 压测临时用户/会话清理 | 已清理，DB 计数为 0 |

## 用例结果

| 用例编号 | 场景 | 执行结果 | 关键证据 |
|---|---|---|---|
| TC-NFR-008 | 空库/1w/10w 会话列表查询性能 | 通过 | 空库 p95 6.49ms；1w p95 126.70ms；10w p95 1256.32ms；5/5 样本均 200 且数量正确 |
| TC-NFR-010 | 创建/删除 50 会话并检查沙箱资源 | 通过 | 10 批，每批 5 会话；全部 WS 连接成功；DELETE 均 204；无遗留容器或目录 |
| TC-WS-025 | WS 空闲 30 分钟后继续发送消息 | 通过 | 空闲连接保持 1800s 后仍 open；发送 chat 后收到 `stream_end` |
| TC-NFR-009 | 100 并发 WebSocket 稳定性 | 通过 | 100/100 连接成功；30 分钟后 100/100 仍 open；异常关闭 0；错误率 0%；ping 5900 次 |

## 清理结果

- 压测临时用户：`long-stability-1779637101069` 已删除。
- 10w 会话列表性能测试数据已删除。
- 50 会话沙箱压测产生的容器和工作目录已清理。
- 最终 Docker 仅剩 `agenthub-postgres-1` 和 `agenthub-redis-1`。
- 观察项：WS close 清理与 DELETE session 清理会同时尝试移除同一容器，API 日志出现非致命 Docker 409 `removal ... already in progress`；最终容器和目录均清理为 0，未影响本轮用例通过，但建议后续降低重复清理噪声。

## 结论

本轮确定性长稳基线通过。该结论只覆盖 test provider 下的 30 分钟 WS/沙箱/容量基线，不覆盖真实 Claude provider、部署、8 小时混合场景、真实非白名单 OAuth 拒绝链路。
