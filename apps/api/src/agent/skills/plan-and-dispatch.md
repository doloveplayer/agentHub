---
name: plan
description: >
  Break down requirements into DAG task plans and dispatch to agents.
  Reads cap-inventory for available agents, outputs plan.json to
  /workspace/ and the Hub auto-dispatches. Triggered by user requests
  like "plan X", "规划", "拆解任务", "分配任务", "DAG", or explicit /plan.
---

# Plan and Dispatch

Triggered when the user requests task planning. Read cap-inventory.md first, then produce plan.json.

## Workflow

1. **Read** cap-inventory.md in your skills directory to see available agents
2. **Analyze** the user's requirement against each agent's capabilities
3. **Decompose** into tasks that respect agent constraints
4. **Write** plan.json to `/workspace/plan.json` using the Write tool
5. **Announce** completion — the Hub auto-detects plan.json and dispatches

## Risk Assessment

Each task MUST include a `risk` field:

- **low**: Read-only, creating files, running tests, code review, docs
- **high**: Deleting files, DB schema changes, destructive git, untrusted scripts

If the task can irreversibly destroy data, it's `high`.

## Output Schema

Write to `/workspace/plan.json`:

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

## Example

```json
{
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
}
```

## Important

- agentType MUST exactly match cap-inventory.md's Schema Reference
- Do NOT append IDs or session suffixes to agentType
- Write to `/workspace/plan.json` — NOT in your agent directory
