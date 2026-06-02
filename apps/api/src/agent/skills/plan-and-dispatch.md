---
name: plan
description: >
  Break down requirements into DAG task plans and dispatch to agents.
  Reads cap-inventory for available agents, outputs plan.json via planGen.
  Triggered by user requests like "plan X", "规划", "拆解任务", "分配任务",
  "DAG", or explicit /plan.
---

# Plan and Dispatch

Triggered when the user requests task planning. Read cap-inventory.md first, then use planGen to generate plan.json.

## Workflow

1. **Read** cap-inventory.md in your skills directory to see available agents
2. **Analyze** the user's requirement against each agent's capabilities
3. **Decompose** into tasks that respect agent constraints
4. **Generate** plan.json using planGen:

   ```bash
   echo '<plan-json>' | node /usr/local/bin/planGen.mjs --mode flat
   ```

   If validation fails, the error output tells you exactly what to fix — correct your JSON and retry. On success, `/workspace/plan.json` is written and the Hub auto-detects and dispatches it.

5. **Announce** completion — the Hub auto-dispatches

## Plan Modes

Choose the mode that best fits your decomposition:

| Mode | When to use | Key behavior |
|------|-------------|--------------|
| `flat` | Simple task list with explicit `dependsOn` | Direct 1:1 mapping |
| `phased` | Logical grouping of tasks into named phases | All tasks flattened into a single list; phases are for organization only |
| `pipeline` | Sequential stages where each stage depends on the previous | Auto-adds `dependsOn`: stage N tasks depend on ALL tasks from stages 0..N-1 |

All modes produce the identical canonical `/workspace/plan.json` format.

## Risk Assessment

Each task MUST include a `risk` field:

- **low**: Read-only, creating files, running tests, code review, docs
- **high**: Deleting files, DB schema changes, destructive git, untrusted scripts

Only `"low"` and `"high"` are valid. High-risk plans require user confirmation.

## Output Schema

All modes accept flexible field names. The required fields are:

```json
{
  "planTitle": "string (required)",
  "summary": "string — one paragraph",
  "tasks": [
    {
      "id": "string (required) — unique e.g. T1, T2",
      "title": "string (required)",
      "description": "string — what to do and produce",
      "agentType": "string (required) — MUST match cap-inventory.md Schema Reference",
      "dependsOn": ["string"] — task IDs this depends on,
      "expectedOutput": "string — file or artifact produced",
      "risk": "low" | "high"
    }
  ]
}
```

## Examples

### Flat mode (standard DAG)

```bash
echo '{
  "planTitle": "Add dark mode toggle",
  "summary": "Add dark mode toggle to settings with CSS variables",
  "tasks": [
    {
      "id": "T1",
      "title": "Implement dark mode CSS and toggle",
      "description": "Add CSS custom properties and toggle in settings.tsx",
      "agentType": "code-agent",
      "dependsOn": [],
      "expectedOutput": "Modified settings.tsx and styles.css",
      "risk": "low"
    },
    {
      "id": "T2",
      "title": "Code review",
      "description": "Review T1 for style consistency",
      "agentType": "review-agent",
      "dependsOn": ["T1"],
      "expectedOutput": "Review report",
      "risk": "low"
    }
  ]
}' | node /usr/local/bin/planGen.mjs --mode flat
```

### Pipeline mode (build → test → deploy)

```bash
echo '{
  "title": "CI/CD Pipeline",
  "stages": [
    {
      "name": "Build",
      "tasks": [
        {"id": "T1", "title": "Build project", "agentType": "code-agent", "risk": "low"}
      ]
    },
    {
      "name": "Test",
      "tasks": [
        {"id": "T2", "title": "Run tests", "agentType": "test-agent", "risk": "low"},
        {"id": "T3", "title": "Lint check", "agentType": "review-agent", "risk": "low"}
      ]
    },
    {
      "name": "Deploy",
      "tasks": [
        {"id": "T4", "title": "Deploy to staging", "agentType": "devops-agent", "risk": "high"}
      ]
    }
  ]
}' | node /usr/local/bin/planGen.mjs --mode pipeline
```

T4 auto-depends on T1, T2, T3 — no need to write `dependsOn` manually.

## Important

- agentType MUST exactly match cap-inventory.md's Schema Reference
- Do NOT append IDs or session suffixes to agentType
- Do NOT use the Write tool to write plan.json directly — ALWAYS use planGen.mjs
- Field name aliases are accepted (e.g., `depends_on` → `dependsOn`, `agent_type` → `agentType`)
- If planGen reports errors, read them carefully and fix your JSON — don't try to bypass it
- Run `node /usr/local/bin/planGen.mjs --help` to see all options
