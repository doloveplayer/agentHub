---
name: troubleshooting-sop
description: AgentHub 排错 SOP。当遇到 bug、测试失败、agent 无响应、沙箱异常、WebSocket 断连、前端渲染错误等任何非预期行为时，必须使用此 skill 按序排查。不要跳步直奔修复，先定位根因。也适用于用户说"报错了"、"不工作了"、"看看日志"、"帮我排查"等场景。
---

# AgentHub 排错 SOP

遇到问题时，按以下顺序逐步排查。每一步都可能直接揭示根因——不要跳过前面的步骤直奔后面的。

## Step 1: 检查日志

```bash
# 查看最新一轮日志
ls -lt logs/ | head -5
tail -100 logs/$(ls -t logs/ | head -1)/backend.log
tail -100 logs/$(ls -t logs/ | head -1)/frontend.log
```

日志按时间戳分目录存储（`logs/YYYY-MM-DD_HH-MM-SS/`）。优先看 `backend.log`，大多数运行时错误都在这里。前端问题看 `frontend.log`。

## Step 2: 检查沙箱输出

```bash
# 列出所有沙箱
ls .sandboxes/

# 查看特定 session 的沙箱内容
ls .sandboxes/{sessionId}/
cat .sandboxes/{sessionId}/plan.json       # 任务计划
cat .sandboxes/{sessionId}/inbox.json      # 待处理消息
```

沙箱目录包含 agent 的实际运行状态。如果 agent 无响应或行为异常，这里通常有线索。

## Step 3: 检查 Agent 持久化目录

```bash
ls .agent-runtime/{agentId}/
cat .agent-runtime/{agentId}/CLAUDE.md            # agent 的指令文件
ls .agent-runtime/{agentId}/memory/               # agent 的记忆
ls .agent-runtime/{agentId}/skills/               # agent 的技能
```

Agent 的持久化状态可能包含导致异常行为的配置或历史上下文。

## Step 4: 检查工作目录

```bash
# 确认 session 绑定的 workspace 内容
ls -la {workspaceDir}/
cat {workspaceDir}/.agenthub/versions.json  # 版本追踪
```

验证工作目录是否存在、内容是否完整、版本追踪文件是否正常。

## Step 5: 检查 Docker 容器状态

```bash
# 查看容器状态
docker ps -a | grep agenthub-sandbox

# 检查特定容器的挂载和配置
docker inspect agenthub-sandbox-{sessionId}

# 查看容器日志
docker logs --tail 50 agenthub-sandbox-{sessionId}
```

验证容器是否运行中、挂载点（`/workspace`, `/sandbox`, `/home/agents`）是否正确、环境变量是否正常。

## Step 6: 检查模型实际输出

```bash
# 通过沙箱日志确认 Claude Code 的真实 stdout/stderr
docker exec agenthub-sandbox-{sessionId} cat /tmp/claude-output.log
```

如果 agent 给出了意外结果，查看模型的原始输出可以区分是模型理解问题还是工具调用问题。

## Step 7: 复现问题

找到触发条件，发送一条测试消息复现问题。观察：
- WebSocket 消息流是否正常
- 后端是否抛出异常
- 前端是否有渲染错误
- 沙箱是否响应

从复现过程中收集的错误信息和日志片段来精确定位根因。

## Step 8: 复杂 bug — 系统化排查

如果以上步骤仍未定位问题，使用 `/systematic-debugging` 技能进行更深入的排查。它会：
- 形成假设并逐一验证
- 检查竞态条件和时序问题
- 分析多组件交互中的边界情况

## 输出格式

排查完成后，输出：
1. **根因**：问题的本质原因（不是表象）
2. **证据**：哪一步、哪个日志/输出揭示了这个根因
3. **修复方案**：具体要改什么文件、什么代码
4. **验证方式**：如何确认修复有效
