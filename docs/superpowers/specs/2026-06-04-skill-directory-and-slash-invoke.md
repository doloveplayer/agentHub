# Skill 完整目录移植 + `/` Slash 调用

> 2026-06-04 | Design Spec

## 目标

1. **Skill 完整移植**：创建 agent 时，预设 skill 的完整目录（含脚本、模板、schema 等）复制到 agent 持久化目录，运行时可用
2. **`/` Slash 调用**：用户在输入框输入 `/<skill-name>` 直接触发 agent 使用该 skill

---

## Part 1：Skill 完整目录移植

### 数据结构变更

`presetSkills.ts` 中的每个 skill 增加 `sourceDir` 字段：

```typescript
// apps/api/src/presetSkills.ts
export interface PresetSkillDef extends SkillDef {
  sourceDir: string;  // 源目录绝对路径
}

export const presetSkills: PresetSkillDef[] = [
  {
    name: 'pdf',
    description: 'PDF processing...',
    content: `...`,                    // SKILL.md 内容（保留，用于 DB 存储）
    sourceDir: '/home/c2216-3090/.claude/plugins/cache/anthropic-agent-skills/document-skills/da20c92503b2/skills/pdf',
  },
  // ...
];
```

### 创建流程

```
CreateAgentModal 选中 skills
  → POST /api/agents { skills: [{ name: 'pdf', ... }] }
  → 后端：AgentDirectoryManager.ensureAgentHome(agentId, ..., skills)
  → 对于每个 skill：
      1. 从 presetSkills 找到 sourceDir
      2. cpSync(sourceDir, .agents/<agentId>/.claude/skills/<skill.name>/, { recursive: true })
      3. SKILL.md 已经包含在内（目录中已有），无需单独写
  → DB Agent.skills 存储 SkillDef（name + description + content）
```

### 运行时同步

已有逻辑无需改动。`AgentDirectoryManager.initialize` 中现有：

```typescript
// Copy global skills (already recursive)
const globalSkills = resolve(globalConfigDir, 'skills');
cpSync(globalSkills, resolve(claudeConfigDir, 'skills'), { recursive: true, force: true });
```

持久化目录中已有完整 skill 目录，沙箱初始化时自然同步。

### AgentConfigEditor 添加 skill

如果用户在 AgentConfigEditor 中通过 "Add Skill" / "Upload .md" 添加 skill：

- **手动添加**：仅写 .md 文件（无 sourceDir，保持现有行为）
- **从预设列表勾选**：调用新增 API 触发目录复制
- **上传 .md**：保持现有行为（单文件）

新增 API：

```typescript
// POST /api/agents/:id/skills — add preset skills to existing agent
agents.post('/:id/skills', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  const { skillNames } = await c.req.json(); // string[]
  
  const agent = await prisma.agent.findUnique({ where: { id } });
  // ... ownership check ...
  
  // Resolve preset skill dirs
  const presetMap = new Map(presetSkills.map(s => [s.name, s]));
  const newSkills: SkillDef[] = [];
  
  for (const name of skillNames) {
    const preset = presetMap.get(name);
    if (!preset) continue;
    // Copy full directory to agent home
    const homeDir = AgentDirectoryManager.getAgentHome(id);
    const targetDir = resolve(homeDir, '.claude', 'skills', name);
    if (existsSync(preset.sourceDir)) {
      cpSync(preset.sourceDir, targetDir, { recursive: true });
    }
    newSkills.push({ name: preset.name, description: preset.description, content: preset.content });
  }
  
  // Merge into DB
  const currentSkills = (agent?.skills as SkillDef[]) || [];
  await prisma.agent.update({
    where: { id },
    data: { skills: [...currentSkills, ...newSkills] },
  });
  
  return c.json({ added: newSkills });
});
```

### AgentConfigEditor UI 改动

Skills 区域增加 "From Presets" 按钮，点击弹出预设 skill 列表（只显示尚未添加的），勾选后调用上述 API：

```
┌─────────────────────────────────────────┐
│  Skills                                 │
│  ⚡ karpathy-guidelines           ✎ 🗑 │
│                                         │
│  [+ Add Custom] [📤 Upload .md]        │
│  [📦 Add from Presets]              ← 新增 │
└─────────────────────────────────────────┘
```

---

## Part 2：`/` Slash Skill 调用

### 前端：MessageInput

扩展已有的 `SlashCommandPopup`。当前 `/` 触发后弹出框列出所有 slash 命令。

**Agent skills 注册为 slash 命令**：

```typescript
// MessageInput.tsx
const agentSkills = useMemo(() => {
  // Collect skills from all agents in the current session
  if (!activeSessionId) return [];
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return [];
  const agentIds = (session.agents || []).map(sa => sa.agentId);
  const skills: { name: string; description: string }[] = [];
  for (const a of agents) {
    if (!agentIds.includes(a.id)) continue;
    for (const s of (a.skills || [])) {
      if (!skills.find(x => x.name === s.name)) {
        skills.push({ name: s.name, description: s.description });
      }
    }
  }
  return skills;
}, [activeSessionId, agents, sessions]);
```

**弹出逻辑**：`/` 触发 → 匹配 `agentSkills` 中 `name` 或 `description` 包含查询字符串的条目。

**发送格式**：

```typescript
// Parse message: "/pdf merge these files"
const match = trimmed.match(/^\/(\S+)\s*(.*)/);
if (match) {
  const [, skillName, rest] = match;
  // Send with skillInvocation
  onSend(rest || `Run ${skillName}`, tags, orchestrationMode, quoteRef, skillName);
}
```

### useChat.send 改动

```typescript
const send = useCallback(async (
  content: string,
  mentionedAgents: MentionTag[] = [],
  mode?: 'parallel' | 'sequential',
  quoteReferenceId?: string | null,
  skillInvocation?: string | null,  // ← 新增
) => {
  // ... existing code ...
  ws.send(JSON.stringify({
    type: 'chat',
    content,
    mentions: ...,
    quoteReferenceId: quoteReferenceId || null,
    trustMode,
    orchestrationMode: mode || orchestrationMode,
    skillInvocation: skillInvocation || null,  // ← 新增
  }));
}, [...]);
```

### 后端：chatHandlers.handleChatMessage

```typescript
// ws/chatHandlers.ts
const skillInvocation = data.skillInvocation || null;

// When building agent prompt:
if (skillInvocation) {
  agentPrompt = `[Skill Invocation: ${skillInvocation}]
Use the '${skillInvocation}' skill from your .claude/skills/${skillInvocation}/ directory.

User request: ${agentPrompt}`;
}
```

### 交互效果

```
用户输入: "/pdf merge report.pdf and invoice.pdf"
  → 前端自动补全提示 "pdf" skill
  → 发送 { skillInvocation: 'pdf', content: 'merge report.pdf and invoice.pdf' }
  → 后端注入:
    "[Skill Invocation: pdf]
     Use the 'pdf' skill from your .claude/skills/pdf/ directory.
     User request: merge report.pdf and invoice.pdf"
  → Agent (Claude Code) 自动加载 /sandbox/_agent_xxx/.claude/skills/pdf/SKILL.md
  → 执行 pdf skill 流程
```

---

### 源目录解析

`presetSkills.ts` 生成时自动发现源目录：

```typescript
// 构建时扫描 ~/.claude 发现 skill 源目录
function discoverSourceDir(skillName: string): string | null {
  const searchPaths = [
    // 1. User custom skills (highest priority)
    resolve(homedir(), '.claude', 'skills', skillName),
    // 2. Installed plugin skills (version-agnostic lookup)
    ...scanPluginCache(skillName),
  ];
  return searchPaths.find(p => existsSync(p)) || null;
}
```

`scanPluginCache` 遍历 `~/.claude/plugins/cache/*/` 子目录，按 skill name 匹配，**不依赖版本号**。预设 skill 生成脚本每次构建时重新扫描，确保路径始终指向当前安装版本。

## 涉及的 skill 源目录

| 来源 | 路径模式 |
|------|---------|
| Document Skills 插件 | `~/.claude/plugins/cache/anthropic-agent-skills/document-skills/da20c92503b2/skills/<name>/` |
| Superpowers 插件 | `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/<name>/` |
| 用户自定义 | `~/.claude/skills/<name>/` |

注：Superpowers skills（brainstorming、systematic-debugging 等）多为纯 .md 文件 + 辅助文档，无脚本目录。Document Skills（pdf、docx、xlsx、pptx 等）有完整脚本目录。

## 文件改动清单

| 文件 | 操作 |
|------|------|
| `apps/api/src/presetSkills.ts` | 新增 `sourceDir` 字段，指向源目录 |
| `apps/api/src/agent/AgentDirectoryManager.ts` | `ensureAgentHome`：skill 含 sourceDir 时完整复制目录 |
| `apps/api/src/routes/agents.ts` | 新增 `POST /:id/skills` 端点 |
| `apps/web/src/components/MessageInput.tsx` | 扩展 SlashCommandPopup，注入 session skills |
| `apps/web/src/hooks/useChat.ts` | `send` 函数新增 `skillInvocation` 参数，编入 WS 消息 |
| `apps/web/src/components/AgentConfigEditor.tsx` | Skills 区域增加 "Add from Presets" 按钮 |
| `apps/api/src/ws/chatHandlers.ts` | `handleChatMessage` 处理 `skillInvocation`，注入 prompt |

## 验证计划

1. 创建 agent 时选中 pdf/docx/xlsx skill → 检查 `.agents/<id>/.claude/skills/pdf/scripts/` 存在
2. `/pdf merge test1.pdf test2.pdf` → WebSocket 消息包含 `skillInvocation: 'pdf'`
3. agent 接收到 `[Skill Invocation: pdf]` 前缀 prompt
4. AgentConfigEditor 中 "Add from Presets" 列出未添加的预设 skills，添加后目录复制
