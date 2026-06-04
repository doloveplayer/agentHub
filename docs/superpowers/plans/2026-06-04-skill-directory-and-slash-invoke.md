# Skill 完整目录移植 + `/` Slash 调用 — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Copy full skill directories (scripts, templates, schemas) to agent persistent home on creation; enable `/skill-name` slash command to invoke skills directly.

**Architecture:** Generate `presetSkills.ts` with `sourceDir` paths via version-agnostic plugin cache scan. Extend existing `ensureAgentHome` to copy directories. Add `POST /:id/skills` endpoint. Extend SlashCommandPopup with session skills. Inject `skillInvocation` through WebSocket chat message.

**Tech Stack:** Node.js fs, Prisma, Hono, React, Zustand, TypeScript

**Spec:** `docs/superpowers/specs/2026-06-04-skill-directory-and-slash-invoke.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/src/presetSkills.ts` | **Regenerate** | Add `sourceDir` field via plugin cache scan |
| `apps/api/src/agent/AgentDirectoryManager.ts` | **Modify** | `ensureAgentHome`: copy full dir for skills with sourceDir |
| `apps/api/src/routes/agents.ts` | **Modify** | Add `POST /:id/skills` (before `/:id` routes) |
| `apps/web/src/components/MessageInput.tsx` | **Modify** | Extend SlashCommandPopup with session agent skills |
| `apps/web/src/hooks/useChat.ts` | **Modify** | Add `skillInvocation` parameter to `send()` |
| `apps/web/src/components/AgentConfigEditor.tsx` | **Modify** | Add "Add from Presets" button |
| `apps/api/src/ws/chatHandlers.ts` | **Modify** | Handle `skillInvocation` in prompt building |

---

### Task 1: 重新生成 presetSkills.ts（含 sourceDir）

**Files:**
- Modify: `apps/api/src/presetSkills.ts`

- [ ] **Step 1: 编写扫描脚本**

```bash
python3 << 'PYEOF'
import os, json

def scan_plugin_cache(skill_name):
    """Version-agnostic scan of ~/.claude/plugins/cache for a skill directory."""
    cache = os.path.expanduser('~/.claude/plugins/cache')
    results = []
    if not os.path.isdir(cache):
        return results
    for publisher in os.listdir(cache):
        pub_dir = os.path.join(cache, publisher)
        if not os.path.isdir(pub_dir):
            continue
        for plugin in os.listdir(pub_dir):
            plugin_dir = os.path.join(pub_dir, plugin)
            if not os.path.isdir(plugin_dir):
                continue
            for version in os.listdir(plugin_dir):
                skill_path = os.path.join(plugin_dir, version, 'skills', skill_name)
                if os.path.isdir(skill_path):
                    results.append(skill_path)
    return results

def discover_source_dir(skill_name):
    """Find a skill's source directory."""
    # 1. User custom skills
    user_path = os.path.expanduser(f'~/.claude/skills/{skill_name}')
    if os.path.isdir(user_path):
        return user_path
    # 2. Plugin cache
    plugin_paths = scan_plugin_cache(skill_name)
    if plugin_paths:
        return plugin_paths[0]
    return None

# Now regenerate presetSkills.ts with sourceDir...
PYEOF
```

Run the above and regenerate `apps/api/src/presetSkills.ts` with each skill having a `sourceDir` field (or `null` if not found).

- [ ] **Step 2: 更新接口和导出**

```typescript
// apps/api/src/presetSkills.ts
export interface PresetSkillDef extends SkillDef {
  sourceDir: string | null;  // null = markdown-only skill with no scripts
}

export const presetSkills: PresetSkillDef[] = [ ... ];
```

For skills whose `sourceDir` is null (no directory found), `ensureAgentHome` falls back to writing just the .md file (current behavior).

For skills with `sourceDir`, `ensureAgentHome` copies the entire directory and skips writing .md separately.

- [ ] **Step 3: 验证编译**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/presetSkills.ts
git commit -m "feat: add sourceDir field to preset skills via plugin cache scan"
```

---

### Task 2: AgentDirectoryManager — 完整目录复制

**Files:**
- Modify: `apps/api/src/agent/AgentDirectoryManager.ts`

- [ ] **Step 1: 修改 ensureAgentHome**

Current code at ~L49-55:
```typescript
// Write custom skills (only if home dir was just created or skills changed)
if (skills && skills.length > 0) {
  const skillsDir = resolve(claudeConfigDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    const skillMd = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}`;
    writeFileSync(resolve(skillsDir, `${skill.name}.md`), skillMd, 'utf-8');
  }
}
```

Replace with:

```typescript
import { PresetSkillDef } from '../presetSkills.js';

// Write custom skills
if (skills && skills.length > 0) {
  const skillsDir = resolve(claudeConfigDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const presetMap = new Map(presetSkills.map(s => [s.name, s]));
  for (const skill of skills) {
    const preset = presetMap.get(skill.name) as PresetSkillDef | undefined;
    if (preset?.sourceDir && existsSync(preset.sourceDir)) {
      // Full directory copy (includes SKILL.md, scripts, templates)
      const targetDir = resolve(skillsDir, skill.name);
      cpSync(preset.sourceDir, targetDir, { recursive: true });
    } else {
      // Fallback: write single .md file
      const skillMd = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}`;
      writeFileSync(resolve(skillsDir, `${skill.name}.md`), skillMd, 'utf-8');
    }
  }
}
```

Same logic applies to `ensureSessionDir` (the `initialize` method which writes custom skills at ~L224-232).

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/agent/AgentDirectoryManager.ts
git commit -m "feat: copy full skill directories when sourceDir available"
```

---

### Task 3: 新增 `POST /:id/skills` 端点

**Files:**
- Modify: `apps/api/src/routes/agents.ts`

- [ ] **Step 1: 添加路由（放在 /:id PUT/PATCH/DELETE 之前）**

```typescript
// POST /:id/skills — add preset skills to an existing agent (MUST be before /:id routes)
agents.post('/:id/skills', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const { skillNames } = body as { skillNames?: string[] };
  if (!skillNames || !Array.isArray(skillNames) || skillNames.length === 0) {
    return c.json({ error: 'skillNames array required' }, 400);
  }

  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  if (agent.createdBy !== userId) return c.json({ error: 'Forbidden' }, 403);

  const presetMap = new Map(presetSkills.map(s => [s.name, s]));
  const newSkills: SkillDef[] = [];
  const homeDir = resolve(config.agentContainer.hostRoot, id, '.claude', 'skills');

  for (const name of skillNames) {
    const preset = presetMap.get(name);
    if (!preset) continue;
    if (preset.sourceDir && existsSync(preset.sourceDir)) {
      cpSync(preset.sourceDir, resolve(homeDir, name), { recursive: true });
    } else {
      const skillMd = `---\nname: ${preset.name}\ndescription: ${preset.description}\n---\n\n${preset.content}`;
      mkdirSync(resolve(homeDir, name), { recursive: true });
      writeFileSync(resolve(homeDir, name, 'SKILL.md'), skillMd, 'utf-8');
    }
    newSkills.push({ name: preset.name, description: preset.description, content: preset.content });
  }

  const currentSkills = (agent.skills as SkillDef[] | null) || [];
  // Deduplicate by name
  const merged = [...currentSkills];
  for (const s of newSkills) {
    if (!merged.find(m => m.name === s.name)) merged.push(s);
  }

  await prisma.agent.update({
    where: { id },
    data: { skills: merged as any },
  });

  return c.json({ added: newSkills });
});
```

Note: import `resolve` from 'path', `existsSync`, `cpSync`, `mkdirSync`, `writeFileSync` from 'fs' at top if missing.

- [ ] **Step 2: 验证编译和测试**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/agents.ts
git commit -m "feat: add POST /:id/skills endpoint for adding preset skills"
```

---

### Task 4: MessageInput — Slash Skill 命令

**Files:**
- Modify: `apps/web/src/components/MessageInput.tsx`

- [ ] **Step 1: 收集当前 session 的 agent skills**

```typescript
// Gather all skills from agents in the active session (deduplicated by name)
const agentSkills = useMemo(() => {
  if (!activeSessionId) return [];
  const sessions = useAppStore.getState().sessions;
  const session = sessions.find(s => s.id === activeSessionId);
  if (!session) return [];
  const agentIds = new Set((session.agents || []).map(sa => sa.agentId));
  const allAgents = useAppStore.getState().agents;
  const seen = new Set<string>();
  const result: { name: string; description: string }[] = [];
  for (const a of allAgents) {
    if (!agentIds.has(a.id)) continue;
    for (const s of (a.skills || [])) {
      if (!seen.has(s.name)) {
        seen.add(s.name);
        result.push({ name: s.name, description: s.description });
      }
    }
  }
  return result;
}, [activeSessionId]);
```

- [ ] **Step 2: 解析 `/skill` 前缀**

In `handleSend` (or wherever the send logic is triggered):

```typescript
// Detect /skill invocation
let skillInvocation: string | null = null;
let finalValue = trimmed;
const slashMatch = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/);
if (slashMatch) {
  const cmd = slashMatch[1].toLowerCase();
  const rest = slashMatch[2] || '';
  // Check if this is a known skill (not a built-in command like /help)
  if (agentSkills.some(s => s.name === cmd)) {
    skillInvocation = cmd;
    finalValue = rest || `Run ${cmd}`;
  }
}
```

- [ ] **Step 3: 更新 SlashCommandPopup**

When showSlash is true, filter both built-in commands AND agentSkills:

```typescript
{showSlash && (
  <SlashCommandPopup
    query={slashQuery}
    focusedIndex={slashIndex}
    onSelect={handleSelectCommand}
    onClose={() => setShowSlash(false)}
    position={{ top: 0, left: 8 }}
    extraItems={agentSkills}  // ← pass agent skills
  />
)}
```

Update `SlashCommandPopup` props to accept optional `extraItems`. When provided, append them to the command list with appropriate icons or labels.

- [ ] **Step 4: Pass skillInvocation through onSend**

```typescript
onSend(finalValue, tags, orchestrationMode, quoteReferenceId, skillInvocation);
```

- [ ] **Step 5: 验证编译**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/MessageInput.tsx apps/web/src/components/SlashCommandPopup.tsx
git commit -m "feat: extend slash commands with session agent skills"
```

---

### Task 5: useChat — skillInvocation 参数

**Files:**
- Modify: `apps/web/src/hooks/useChat.ts`

- [ ] **Step 1: 更新 send 签名**

```typescript
const send = useCallback(async (
  content: string,
  mentionedAgents: MentionTag[] = [],
  mode?: 'parallel' | 'sequential',
  quoteReferenceId?: string | null,
  skillInvocation?: string | null,  // new
) => {
  // ... existing addMessage + api.sendMessage + addStreamingMessage ...
  ws.send(JSON.stringify({
    type: 'chat',
    content,
    mentions: result.agentMessages.map((am) => ({
      agentId: am.agentId,
      messageId: am.agentMessageId,
      subPrompt: mentions.find((m) => m.agentId === am.agentId)?.subPrompt ?? content,
    })),
    quoteReferenceId: quoteReferenceId || null,
    trustMode,
    orchestrationMode: mode || orchestrationMode,
    skillInvocation: skillInvocation || null,  // new
  }));
}, [sessionId, agents, trustMode, orchestrationMode, ...]);
```

- [ ]**Step 2: 验证编译**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ]**Step 3: Commit**

```bash
git add apps/web/src/hooks/useChat.ts
git commit -m "feat: add skillInvocation parameter to send()"
```

---

### Task 6: 后端 — 处理 skillInvocation

**Files:**
- Modify: `apps/api/src/ws/chatHandlers.ts`

- [ ]**Step 1: 提取并注入 skillInvocation**

Find the `handleChatMessage` function header (around line 207-243). Add `skillInvocation` destructuring:

```typescript
const {
  messageId, content, prompt, agentId, trustMode,
  orchestrationMode = 'parallel',
  skillInvocation = null,  // new
  mentions: dataMentions,
  quoteReferenceId,
} = data;
```

When building `agentPrompt` for each mention (around line 308+), prepend the skill invocation if present:

```typescript
let agentPrompt = mention.subPrompt;
if (skillInvocation) {
  agentPrompt = `[Skill Invocation: ${skillInvocation}]
Use the '${skillInvocation}' skill from your .claude/skills/${skillInvocation}/ directory.
Read the SKILL.md in that directory and follow its instructions.

User request: ${agentPrompt}`;
}
```

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/ws/chatHandlers.ts
git commit -m "feat: handle skillInvocation in chat message dispatch"
```

---

### Task 7: AgentConfigEditor — "Add from Presets" 按钮

**Files:**
- Modify: `apps/web/src/components/AgentConfigEditor.tsx`

- [ ] **Step 1: 获取 agent 已有 skill 名和预设列表**

```typescript
const [presetList, setPresetList] = useState<{ name: string; description: string }[]>([]);
const [showPresetPicker, setShowPresetPicker] = useState(false);

useEffect(() => {
  api.getPresetSkills().then(setPresetList).catch(() => {});
}, []);
```

- [ ] **Step 2: 添加按钮 + 弹窗**

After the existing "+ Add Custom" / "Upload .md" buttons:

```tsx
<button
  onClick={() => setShowPresetPicker(true)}
  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded border border-hub-accent/30 text-hub-accent hover:bg-hub-accent/10 transition"
>
  <Package className="w-3 h-3" /> Add from Presets
</button>

{showPresetPicker && (
  <PresetSkillPicker
    presetSkills={presetList}
    existingSkillNames={skills.map(s => s.name)}
    onSelect={async (selected) => {
      if (selected.length === 0) { setShowPresetPicker(false); return; }
      await api.request(`/agents/${agentId}/skills`, {
        method: 'POST',
        body: JSON.stringify({ skillNames: selected }),
      });
      // Refresh agent data from store
      const updated = await api.getAgent(agentId);
      if (updated) {
        setSkills((updated.skills || []) as EditableSkill[]);
        useAppStore.getState().setAgents(
          useAppStore.getState().agents.map(a => a.id === agentId ? { ...a, ...updated } : a)
        );
      }
      setShowPresetPicker(false);
    }}
    onClose={() => setShowPresetPicker(false)}
  />
)}
```

PresetSkillPicker is a simple modal: checkbox list of preset skills that are NOT already in existingSkillNames, with search filter, confirm button.

- [ ] **Step 3: 简化 creating 流程集成**

When creating from CreateAgentModal: the POST /agents endpoint already triggers ensureAgentHome which copies directories. The AgentConfigEditor's "Add from Presets" only needs the POST /:id/skills endpoint.

- [ ] **Step 4: 验证编译**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AgentConfigEditor.tsx apps/web/src/components/PresetSkillPicker.tsx
git commit -m "feat: add 'Add from Presets' button to AgentConfigEditor"
```

---

### Task 8: 端到端验证

- [ ] **Step 1: 全量编译**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```

- [ ] **Step 2: 重启服务**

```bash
bash scripts/cleanup.sh && bash scripts/startup.sh
```

- [ ] **Step 3: 测试 skill 目录复制**

```bash
# Create agent with pdf skill
TOKEN=$(curl -s http://localhost:3000/api/auth/dev-token | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
AGENT=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"pdf-test","displayName":"PDF Test","description":"Test","systemPrompt":"You are a test assistant.","skills":[{"name":"pdf","description":"","content":""}]}' \
  http://localhost:3000/api/agents)

AGENT_ID=$(echo "$AGENT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# Check that pdf skill directory was copied
ls /home/c2216-3090/disB/hyh/agentHub/.agents/$AGENT_ID/.claude/skills/pdf/scripts/
# Expected: check_fillable_fields.py, extract_form_field_info.py, etc.
```

- [ ] **Step 4: 测试 slash 调用**

```bash
# Open WebSocket, send chat with skillInvocation
# Verify agent receives prompt with [Skill Invocation: pdf] prefix
```

- [ ] **Step 5: 清理测试数据**

```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/agents/$AGENT_ID"
```

- [ ] **Step 6: Commit remaining**

```bash
git add -A && git commit -m "chore: end-to-end verification of skill dir copy + slash invoke"
```

---

## Verification Checklist

- [ ] `presetSkills.ts` has `sourceDir` for pdf, docx, xlsx, pptx, webapp-testing
- [ ] Creating agent with pdf skill: `.agents/<id>/.claude/skills/pdf/scripts/` exists
- [ ] Creating agent with karpathy-guidelines (no sourceDir): `.md` file written as before
- [ ] `POST /:id/skills` adds new skill directory to existing agent
- [ ] `//pdf merge ...` → WebSocket message includes `skillInvocation: 'pdf'`
- [ ] Agent receives `[Skill Invocation: pdf]` prefix in prompt
- [ ] `npx tsc --noEmit` passes for api + web
