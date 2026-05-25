# AgentHub Phase 2 UX Remnants — Polish Design (Tier 3)

> Status: **Complete** (all 5 verifications pass) · Date: 2026-05-20 · Updated: 2026-05-25

> Note 2026-05-25: UI colors aligned to Understand Anything dashboard redesign. Component styling now uses CSS custom properties from `apps/web/src/index.css` `:root` block (teal accent `#4fd1c5`, layered dark backgrounds). SlashCommandPopup and AgentMentionPopup use `bg-hub-raised border-hub` pattern.

## Key Decisions

1. **Slash command panel mirrors AgentMentionPopup**: Reuse the same keyboard-nav popup pattern (↑↓ Enter Esc). Command list is static (8 commands), no server-side discovery needed.
2. **Unread badges in session list, not multi-tab**: Full multi-tab (multiple active WS connections rendering simultaneously) deferred to Phase 4. Simpler approach: per-session unread counter incremented on stream_chunk when session is inactive.
3. **Context-based agent recommendation via keyword scoring**: No ML/NLP. Simple keyword→agent mapping based on recent message content (bug→CodeAgent, deploy→DevOpsAgent, review→ReviewAgent).

## Architecture

```
Slash Command Panel:
  MessageInput detects "/" → SlashCommandPopup opens
  → keyboard nav (↑↓ Enter Esc) → select → auto-fill input
  → backend already handles / transparent passthrough

Unread Badges:
  WS stream_chunk arrives → if sessionId !== activeSessionId:
  → store.incrementUnread(sessionId)
  → SessionList renders badge count (max 99+)
  → store.clearUnread(sessionId) on session switch

Agent Recommendation:
  parseMentions → matchAgents → recommendAgents(query, agents, recentMessages)
  → keyword scoring reorders matched agents
  → AgentMentionPopup shows scored order
```

## File Structure

```
apps/web/src/components/
  SlashCommandPopup.tsx    # / 命令补全面板（8 commands: /plan, /review, /fix, ...）
  SessionList.tsx          # [modified] unread badge rendering
  MessageInput.tsx         # [modified] slash detection + popup integration

apps/web/src/lib/
  mentionParser.ts         # [modified] recommendAgents() keyword scoring

apps/web/src/store/
  appStore.ts              # [modified] unreadCounts, incrementUnread, clearUnread
```

## Slash Commands

| Command | Description | Routes To |
|---------|-------------|-----------|
| /plan | Create task plan | Planner Agent |
| /review | Request code review | ReviewAgent |
| /fix | Fix bug or issue | CodeAgent |
| /deploy | Deploy project | DevOpsAgent |
| /init | Initialize new project | CodeAgent |
| /test | Generate and run tests | CodeAgent |
| /audit | Security audit | ReviewAgent |
| /compact | Compact context | Claude Code native |

## Keyword Scoring Map

| Keyword Pattern | Agent Boost |
|-----------------|-------------|
| bug, fix, error, crash, broken | CodeAgent +10 |
| review, check, audit, inspect | ReviewAgent +10 |
| deploy, docker, build, release, ci | DevOpsAgent +10 |
| plan, design, architect | Planner +10 |

## Verification

- [x] Typing "/" shows command popup with 8 commands
- [x] Keyboard nav (↑↓ Enter Esc) works identically to @mention popup
- [x] Unread badge appears on inactive session when stream_chunk arrives
- [x] Unread badge clears when switching to that session
- [x] Agent recommendation orders agents by keyword relevance
