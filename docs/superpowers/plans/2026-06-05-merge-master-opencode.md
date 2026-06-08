# Merge master + OpenCode 冲突解决计划

> **目标:** 将远端 master (20 commits ahead) 合并到本地 feature/agent-output-editor，保留所有 OpenCode 功能

## 文件 1: `apps/api/src/routes/agents.ts`

以远端为基 (保留新的 `POST /agents`、`GET /preset-skills`、`POST /skills/validate` 等)，逐点覆盖：

- [ ] `createSchema` 加 `provider: z.enum(['claude-code', 'opencode']).optional()`
- [ ] `updateSchema`: `['claude-code', 'codex']` → `['claude-code', 'opencode']`
- [ ] `from-md`: 类型断言 `'claude-code' | 'codex'` → `meta.provider || 'claude-code'` + `VALID_PROVIDERS` 运行时校验
- [ ] `from-md`: 删除 Codex API key 检查块
- [ ] `getDefaultProviderConfig`: `'codex' → 'gpt-5'` → `'opencode' → 'deepseek-chat'`
- [ ] `PUT /:id`: 加 provider 变更检测 + `restartProvider` + `mergedConfig`
- [ ] imports: 加 `import { agentRuntime } from '../agent/AgentRuntime.js'`

## 文件 2: `apps/web/src/components/AgentConfigEditor.tsx`

以远端重构后的组件为基，嵌入 Platform 下拉框：

- [ ] State: 加 `const [provider, setProvider] = useState('claude-code')`
- [ ] useEffect: 在 `if (a) { ... }` 块内加 `setProvider(a.provider || 'claude-code')`
- [ ] handleSave: `api.updateAgent(...)` body 加 `provider,`
- [ ] UI: 在 System Prompt textarea 下方插入 Platform `<select>` 下拉框

## 文件 3: `apps/web/src/lib/api.ts`

远端加了 `getPresetSkills`、`createAgent`，我们给 `updateAgent` body 加 `provider?: string`。无冲突，直接合并。

## 验证

- [ ] `npx tsc --noEmit -p apps/api/tsconfig.json` 零新增错误
- [ ] `npx tsc --noEmit -p apps/web/tsconfig.json` 零错误
- [ ] `grep -rn "codex" apps/api/src/ apps/web/src/ packages/ --include="*.ts" --include="*.tsx"` 无残留
- [ ] `grep -rn "opencode" apps/api/src/routes/agents.ts` 确认所有位置
