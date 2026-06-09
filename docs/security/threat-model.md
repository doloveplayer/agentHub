# AgentHub 安全威胁模型

> 最后更新：2026-06-09
> 覆盖版本：v0.6.0

## 1. 系统边界与信任域

```
┌─────────────────────────────────────────────┐
│  用户浏览器（不可信）                          │
│  - JWT token                                 │
│  - 用户输入                                  │
│  - iframe 预览                               │
└──────────────┬──────────────────────────────┘
               │ HTTPS / WSS
┌──────────────▼──────────────────────────────┐
│  API 服务（半可信）                            │
│  - Hono + WebSocket                          │
│  - JWT 认证                                  │
│  - 权限代理                                  │
└──────────────┬──────────────────────────────┘
               │ Docker API
┌──────────────▼──────────────────────────────┐
│  Docker 沙箱（不可信）                         │
│  - Agent 进程                                │
│  - 用户代码                                  │
│  - 文件系统                                  │
└─────────────────────────────────────────────┘
```

## 2. 威胁清单

### T1: 沙箱逃逸

| 维度 | 详情 |
|------|------|
| **风险等级** | 🔴 严重 |
| **攻击面** | Docker 容器 → 宿主机 |
| **攻击向量** | 容器内提权、内核漏洞利用、Docker socket 挂载 |
| **现有缓解** | Docker 内核安全特性、容器内存限制（Solo 512MB / Group 2048MB）、`--rm` 自动清理 |
| **缺失缓解** | 未启用 seccomp/AppArmor 策略、未使用只读根文件系统、Docker socket 挂载给 API 容器 |
| **建议** | 1. 启用 `--security-opt=no-new-privileges`<br>2. 使用 `--read-only` + tmpfs 挂载可写目录<br>3. 评估是否需要 Docker socket 挂载（考虑 Docker-in-Docker 替代方案） |

### T2: 环境变量泄露

| 维度 | 详情 |
|------|------|
| **风险等级** | 🟡 中 |
| **攻击面** | API 服务 → 沙箱容器 |
| **攻击向量** | Agent 在沙箱内执行 `env` 或 `printenv` 读取环境变量 |
| **现有缓解** | `SAFE_ENV_PREFIXES` 白名单（仅放行 ANTHROPIC_/CLAUDE_/PATH/HOME 等安全前缀） |
| **缺失缓解** | 白名单需定期审查、无运行时审计日志 |
| **代码依据** | `agent/ClaudeCodeProcess.ts:10-22` |

### T3: XSS / iframe 注入

| 维度 | 详情 |
|------|------|
| **风险等级** | 🟡 中 |
| **攻击面** | Agent 生成的 HTML 内容 → 用户浏览器 |
| **攻击向量** | Agent 生成包含恶意 JavaScript 的 HTML，通过 iframe 预览执行 |
| **现有缓解** | iframe 预览通过代理端口映射，非直接 `srcdoc` |
| **缺失缓解** | 未设置 `sandbox` 属性限制 iframe 能力、未配置 CSP 头 |
| **建议** | 1. iframe 添加 `sandbox="allow-scripts allow-same-origin"` 限制<br>2. 预览代理添加 `Content-Security-Policy` 头<br>3. 预览域名与主站域名隔离 |

### T4: JWT Token 安全

| 维度 | 详情 |
|------|------|
| **风险等级** | 🟡 中 |
| **攻击面** | 用户认证 |
| **攻击向量** | Token 窃取、重放攻击、弱密钥 |
| **现有缓解** | JWT 7 天过期、`JWT_SECRET` 环境变量注入（非硬编码） |
| **缺失缓解** | 无 token 刷新机制、无 token 黑名单（用户无法主动吊销） |
| **代码依据** | `config.ts:161-162` — jwt.secret |

### T5: Agent 权限代理绕过

| 维度 | 详情 |
|------|------|
| **风险等级** | 🟡 中 |
| **攻击面** | 权限确认机制 |
| **攻击向量** | 120s 超时 auto-deny 可被 Agent 绕过（快速连续请求耗尽超时）；Trust ON 模式跳过所有权限检查 |
| **现有缓解** | 权限代理默认关闭（Trust OFF）、超时 auto-deny |
| **缺失缓解** | Trust ON 模式无操作审计日志、无敏感操作白名单 |
| **代码依据** | `agent/providers/claude-code.ts:11-15` — resolvePermissionProfile |

### T6: 文件系统越权访问

| 维度 | 详情 |
|------|------|
| **风险等级** | 🟢 低 |
| **攻击面** | 沙箱内 Agent 访问宿主机文件 |
| **攻击向量** | 通过 bind mount 路径遍历访问沙箱外文件 |
| **现有缓解** | 三分区挂载隔离（/sandbox、/workspace、/home/agents）、自定义工作目录需用户显式配置 |
| **缺失缓解** | 未限制 Agent 对 /workspace 的写入范围（可写任意子目录） |

### T7: API Key 存储安全

| 维度 | 详情 |
|------|------|
| **风险等级** | 🟡 中 |
| **攻击面** | 数据库中存储的 API Key |
| **攻击向量** | 数据库泄露导致 API Key 泄露 |
| **现有缓解** | AES-256-GCM 加密存储、前端脱敏显示 |
| **缺失缓解** | 加密密钥与数据库同服务器存储（需分离） |

### T8: WebSocket 认证绕过

| 维度 | 详情 |
|------|------|
| **风险等级** | 🟡 中 |
| **攻击面** | WebSocket 连接 |
| **攻击向量** | 伪造 JWT 建立 WebSocket 连接 |
| **现有缓解** | WebSocket 握手时验证 JWT |
| **缺失缓解** | 无连接速率限制、无单用户连接数限制 |

## 3. 安全加固优先级

| 优先级 | 措施 | 工作量 | 影响 |
|--------|------|--------|------|
| P0 | iframe sandbox 属性 + CSP 头 | 小 | 防止 XSS 注入 |
| P0 | Docker 容器启用 no-new-privileges | 小 | 防止沙箱提权 |
| P1 | 审计日志（Trust ON 模式下的所有操作） | 中 | 可追溯性 |
| P1 | JWT token 刷新机制 | 中 | 减少 token 暴露窗口 |
| P2 | Docker 只读根文件系统 + tmpfs | 中 | 进一步限制沙箱能力 |
| P2 | 加密密钥与数据库分离 | 大 | 降低数据泄露影响 |

## 4. 依赖安全

| 依赖 | 用途 | 安全注意事项 |
|------|------|------------|
| Dockerode | Docker API 交互 | 需要 Docker socket 访问权限 |
| @anthropic-ai/sdk | Claude Agent SDK | API Key 通过环境变量传递 |
| bcrypt | 密码哈希 | 安全，无已知问题 |
| jsonwebtoken | JWT 签发/验证 | 需确保密钥强度 |
| ws | WebSocket | 需验证连接来源 |

## 5. 安全相关代码位置

| 功能 | 文件 | 行号 |
|------|------|------|
| 环境变量白名单 | `agent/ClaudeCodeProcess.ts` | 10-22 |
| JWT 配置 | `config.ts` | 161-162 |
| 权限模式解析 | `agent/providers/claude-code.ts` | 11-15 |
| 沙箱创建 | `agent/SandboxManager.ts` | 29-90 |
| 权限超时配置 | `config.ts` | 53 |
| API Key 加密 | `agent/providers/` | Provider 内部 |
