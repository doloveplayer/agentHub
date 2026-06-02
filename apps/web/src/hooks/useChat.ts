import { useCallback, useEffect, useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { api } from '../lib/api';
import { parseMentions } from '../lib/mentionParser';
import { safeContent } from '../lib/text';
import type { Message, AgentConfig } from '@agenthub/shared';

export const socketPool = new Map<string, WebSocket>();

function findMessageSessionId(agentMessageId: string | undefined, fallback: string): string {
  if (!agentMessageId) return fallback;
  const messages = useAppStore.getState().messages;
  for (const [candidateSessionId, sessionMessages] of Object.entries(messages)) {
    if (sessionMessages.some((message) => message.id === agentMessageId)) return candidateSessionId;
  }
  return fallback;
}

interface MentionTag {
  agentId: string;
  agentName: string;
  displayName: string;
}

export function useChat(sessionId: string) {
  const token = useAppStore((s) => s.token);
  const agents = useAppStore((s) => s.agents);
  const sessionPermissionModes = useAppStore((s) => s.sessionPermissionModes);
  const sessions = useAppStore((s) => s.sessions);
  const orchestrationMode = useAppStore((s) => s.orchestrationMode);
  // Derive effective trust mode from session-specific permission mode, matching backend logic
  const permMode = sessionPermissionModes[sessionId] || sessions.find(s => s.id === sessionId)?.permissionMode || 'ask';
  const trustMode = permMode === 'smart' || permMode === 'trust';
  // Session-filtered agent list for mention parsing — in group sessions, only
  // session members should be reachable via plain-text @mention, matching the
  // dropdown behavior in MessageInput.
  const mentionableAgents = useMemo(() => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session || (session as any).type !== 'group') return agents;
    const memberIds = new Set(((session as any)?.agents || []).map((sa: any) => sa.agentId));
    return agents.filter((a) => memberIds.has(a.id));
  }, [agents, sessions, sessionId]);
  const { addMessage, appendToMessage, setMessageStatus, addAgentEvent, addStreamingMessage, removeStreamingMessage, setTaskPlan, removeTaskPlan, incrementUnread, addDiffCard, upsertDeploymentCard, addTestReport, addReviewReport, addToast } = useAppStore();

  const ensureConnection = useCallback((): Promise<WebSocket> => {
    if (!token || !sessionId) return Promise.reject(new Error('No token or sessionId'));

    const existing = socketPool.get(sessionId);
    if (existing) {
      if (existing.readyState === WebSocket.OPEN) return Promise.resolve(existing);
      if (existing.readyState === WebSocket.CONNECTING) {
        return new Promise((resolve, reject) => {
          const check = () => {
            if (existing.readyState === WebSocket.OPEN) {
              existing.removeEventListener('open', check);
              resolve(existing);
            }
          };
          existing.addEventListener('open', check);
          setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000);
        });
      }
      socketPool.delete(sessionId);
    }

    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws?token=${token}&sessionId=${sessionId}`);
      socketPool.set(sessionId, ws);

      const timeout = setTimeout(() => {
        socketPool.delete(sessionId);
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log('[WS] Connected to session', sessionId);
        resolve(ws);
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          switch (data.type) {
            case 'stream_chunk':
              {
                const targetSessionId = findMessageSessionId(data.agentMessageId, sessionId);
                appendToMessage(targetSessionId, data.agentMessageId, safeContent(data.content));
                // Increment unread only when the user is viewing a DIFFERENT session
                const store = useAppStore.getState();
                if (store.activeSessionId !== targetSessionId) {
                  incrementUnread(targetSessionId);
                }
              }
              break;
            case 'stream_end': {
              const targetSessionId = findMessageSessionId(data.agentMessageId, sessionId);
              // Fallback: populate content from fullContent if no stream_chunks arrived.
              // The backend sends fullContent as accumulated text or a fallback placeholder.
              if (data.fullContent) {
                const state = useAppStore.getState();
                const msg = state.messages[targetSessionId]?.find(m => m.id === data.agentMessageId);
                if (msg && !msg.content) {
                  appendToMessage(targetSessionId, data.agentMessageId, safeContent(data.fullContent));
                }
              }
              setMessageStatus(targetSessionId, data.agentMessageId, data.exitCode === 0 ? 'done' : 'error');
              removeStreamingMessage(targetSessionId, data.agentMessageId);
              break;
            }
            case 'stream_error': {
              const errMsg = safeContent(data.error) || safeContent(data.message) || 'Unknown agent error';
              console.error('[WS] Agent error:', errMsg);
              addToast(errMsg, 'error');
              if (data.agentMessageId) {
                const targetSessionId = findMessageSessionId(data.agentMessageId, sessionId);
                appendToMessage(targetSessionId, data.agentMessageId, `\n\n---\n**Error:** ${errMsg}`);
                setMessageStatus(targetSessionId, data.agentMessageId, 'error');
                removeStreamingMessage(targetSessionId, data.agentMessageId);
              }
              break;
            }
            case 'agent_queued':
              if (data.agentMessageId) {
                const targetSessionId = findMessageSessionId(data.agentMessageId, sessionId);
                setMessageStatus(targetSessionId, data.agentMessageId, 'queued');
                appendToMessage(targetSessionId, data.agentMessageId, `\n\n---\n**Queued:** ${data.message || 'Waiting for available agent slot...'}`);
              }
              break;
            case 'agent_wakeup':
              // Inbox wakeup creates a new message — register it for streaming display
              if (data.agentMessageId && data.agentName) {
                const targetSessionId = findMessageSessionId(data.agentMessageId, sessionId);
                const store = useAppStore.getState();
                const existing = store.messages[targetSessionId]?.find(m => m.id === data.agentMessageId);
                if (!existing) {
                  store.addMessage(targetSessionId, {
                    id: data.agentMessageId, sessionId: targetSessionId,
                    senderType: 'agent', agentId: '', content: '', status: 'streaming',
                    createdAt: new Date().toISOString(),
                  } as Message);
                  store.addStreamingMessage(targetSessionId, data.agentMessageId);
                }
              }
              break;
            case 'agent_queue_heartbeat':
              // Update queue position in real-time for queued agents
              if (data.agentMessageId) {
                addAgentEvent(data.agentMessageId, {
                  id: 'hb-' + Date.now(),
                  type: 'tool_result',  // reuse existing type for display
                  timestamp: data.timestamp || Date.now(),
                  details: { content: `排队中 (位置 ${data.position}/${data.totalQueued}, 已等待 ${data.waitSeconds}s)` },
                });
              }
              break;
            case 'connected':
              console.log('[WS] Server confirmed connection for session', data.sessionId);
              break;
            case 'permission_request':
              if (data.agentMessageId) {
                addAgentEvent(data.agentMessageId, {
                  id: data.permissionId || 'perm-' + Date.now(),
                  type: 'permission_request',
                  timestamp: data.timestamp || Date.now(),
                  details: { tool: data.tool, path: data.path, permissionId: data.permissionId },
                });
              }
              break;
            case 'agent_status': {
              const eventType = data.status as AgentEvent['type'];
              // The backend also sends a top-level permission_request event
              // with the same permissionId. Use that as the single interactive
              // card source to avoid duplicate Allow/Deny controls.
              if (eventType === 'permission_request') break;
              // Transition queued → streaming when agent starts processing
              if (data.status === 'running' && data.agentMessageId) {
                const targetSessionId = findMessageSessionId(data.agentMessageId, sessionId);
                setMessageStatus(targetSessionId, data.agentMessageId, 'streaming');
                addStreamingMessage(targetSessionId, data.agentMessageId);
                break;
              }
              if (data.agentMessageId && eventType) {
                addAgentEvent(data.agentMessageId, {
                  id: 'ae-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                  type: eventType,
                  timestamp: data.timestamp || Date.now(),
                  details: data.details || {},
                });
              }
              break;
            }
            case 'token_update':
              if (data.agentMessageId) {
                addAgentEvent(data.agentMessageId, {
                  id: 'tu-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                  type: 'token_update',
                  timestamp: data.timestamp || Date.now(),
                  details: {
                    tokenUsage: {
                      input: data.details?.tokenUsage?.input ?? 0,
                      output: data.details?.tokenUsage?.output ?? 0,
                      cacheRead: data.details?.tokenUsage?.cacheRead ?? 0,
                      cacheCreate: data.details?.tokenUsage?.cacheCreate ?? 0,
                      contextPct: data.details?.tokenUsage?.contextPct ?? 0,
                    },
                  },
                });
              }
              break;
            case 'plan_result':
              if (data.planId && data.tasks) {
                setTaskPlan(sessionId, data.planId, data.tasks);
              }
              break;
            case 'plan_recovered':
              if (data.planId && data.tasks) {
                setTaskPlan(sessionId, data.planId, data.tasks);
              }
              break;
            case 'plan_archived':
              if (data.planId) {
                addToast(`Plan ${data.planId.slice(0, 8)} 归档完成 · ${data.experienceCount || 0} 条经验`, 'success');
                // Trim task plans: keep only the latest 3 completed plans per session
                const store = useAppStore.getState();
                const sessionPlans = store.taskPlans[sessionId] ?? {};
                const planIds = Object.keys(sessionPlans);
                if (planIds.length > 3) {
                  planIds.sort().reverse();
                  for (const pid of planIds.slice(3)) {
                    store.removeTaskPlan(sessionId, pid);
                  }
                }
              }
              break;
            case 'plan_executing':
              // Individual task_assigned/task_completed/task_failed events drive
              // node status. Keep unresolved dependencies waiting here.
              break;
            case 'task_assigned':
              if (data.planId && data.taskId && data.agentName) {
                const store = useAppStore.getState();
                store.setTaskAgent(data.planId, data.taskId, data.agentId, data.agentName);
                // Create local message so AgentCard detects running status and shows events
                if (data.taskMessageId && data.agentId) {
                  const existing = store.messages[sessionId]?.find(m => m.id === data.taskMessageId);
                  if (!existing) {
                    store.addMessage(sessionId, {
                      id: data.taskMessageId,
                      sessionId,
                      senderType: 'agent',
                      agentId: data.agentId,
                      content: '',
                      status: 'streaming',
                      createdAt: new Date().toISOString(),
                    } as Message);
                    store.addStreamingMessage(sessionId, data.taskMessageId);
                  }
                }
              }
              break;
            case 'agent_reassigned':
              if (data.planId && data.taskId && data.to) {
                const store = useAppStore.getState();
                const agentId = data.agentId || store.agents.find((agent) => agent.name === data.to)?.id || '';
                store.setTaskAgent(data.planId, data.taskId, agentId, data.to);
              }
              break;
            case 'conflict_detected': {
              const cfStore = useAppStore.getState();
              const conflictFiles = (data.conflicts || []).map((c: any) =>
                `  - ${c.filePath} (${c.agents.join(', ')})`
              ).join('\n');
              const cfMsg: Message = {
                id: 'cf-' + Date.now(),
                sessionId,
                senderType: 'agent',
                content: `## Conflict Detected\n\nMultiple agents modified the same files:\n${conflictFiles}`,
                status: 'done',
                createdAt: new Date().toISOString(),
              };
              cfStore.addMessage(sessionId, cfMsg);
              break;
            }
            case 'conflict_resolved': {
              const crStore = useAppStore.getState();
              const mergedFiles = (data.files || []).map((f: any) =>
                `  - ${f.filePath} (auto-merged from ${f.agents.join(', ')})`
              ).join('\n');
              const crMsg: Message = {
                id: 'cr-' + Date.now(),
                sessionId,
                senderType: 'agent',
                content: `## Auto-Merge Succeeded\n\nNon-overlapping changes automatically merged:\n${mergedFiles}`,
                status: 'done',
                createdAt: new Date().toISOString(),
              };
              crStore.addMessage(sessionId, crMsg);
              break;
            }
            case 'conflict_unresolved': {
              const cuStore = useAppStore.getState();
              const conflictingFiles = (data.files || []).map((f: any) =>
                `  - ${f.filePath} (conflict between ${f.agents.join(', ')})`
              ).join('\n');
              const cuMsg: Message = {
                id: 'cu-' + Date.now(),
                sessionId,
                senderType: 'agent',
                content: `## Manual Merge Required\n\nChanges overlap and could not be auto-merged:\n${conflictingFiles}\n\nPlease check the affected files and resolve conflicts manually.`,
                status: 'done',
                createdAt: new Date().toISOString(),
              };
              cuStore.addMessage(sessionId, cuMsg);
              break;
            }
            case 'inbox_update':
              if (data.agentName) {
                useAppStore.getState().addInboxNotification(data.agentName);
              }
              break;
            case 'session_renamed':
              if (data.sessionId && data.newTitle) {
                useAppStore.getState().updateSessionInList(data.sessionId, { title: data.newTitle });
              }
              break;
            case 'agent_joined':
              if (data.sessionId && data.agent) {
                useAppStore.getState().addAgentToSession(data.sessionId, data.agent);
              }
              break;
            case 'agent_left':
              if (data.sessionId && data.agentId) {
                useAppStore.getState().removeAgentFromSession(data.sessionId, data.agentId);
              }
              break;
            case 'agent_added':
              if (data.agentId && data.sessionId) {
                // Refresh session agents from API
                api.getSession(data.sessionId).then((s: any) => {
                  useAppStore.getState().updateSessionInList(data.sessionId, { agents: s.agents });
                }).catch(() => {});
              }
              break;
            case 'agent_removed':
              if (data.agentId && data.sessionId) {
                // Refresh session agents from API
                api.getSession(data.sessionId).then((s: any) => {
                  useAppStore.getState().updateSessionInList(data.sessionId, { agents: s.agents });
                }).catch(() => {});
              }
              break;
            case 'inbox_wake_up':
              if (data.agentName && data.count > 0) {
                useAppStore.getState().addInboxNotification(data.agentName);
                const wakeMsg: Message = {
                  id: 'wake-' + Date.now(),
                  sessionId,
                  senderType: 'agent',
                  content: data.suggestion || `@${data.agentName} has ${data.count} unread messages.`,
                  status: 'done',
                  createdAt: new Date().toISOString(),
                };
                useAppStore.getState().addMessage(sessionId, wakeMsg);
              }
              break;
            case 'permission_violation':
              if (data.agentMessageId) {
                addAgentEvent(data.agentMessageId, {
                  id: 'pv-' + Date.now(),
                  type: 'permission_request',
                  timestamp: data.timestamp || Date.now(),
                  details: {
                    tool: data.toolName,
                    path: data.filePath,
                    content: `${data.reason || 'Permission denied'} → Delegating to ${data.delegateTo || 'unknown'}`,
                  },
                });
              }
              if (data.agentName) {
                useAppStore.getState().addInboxNotification(data.agentName);
              }
              break;
            case 'agent_missing': {
              const store = useAppStore.getState();
              const fallbackNote = data.fallbackAgent
                ? ` (已自动分配给 ${data.fallbackAgent})`
                : '';
              // Add a system message to notify user
              const sysMsg: Message = {
                id: 'sys-' + Date.now(),
                sessionId,
                senderType: 'agent',
                content: `⚠️ 任务 "${data.taskTitle}" 需要 ${data.agentType}，但群内无此类型 Agent${fallbackNote}。${data.suggestedAgent ? `建议添加: ${data.suggestedAgent.displayName} (${data.suggestedAgent.description})` : ''}`,
                status: 'done',
                createdAt: new Date().toISOString(),
              };
              store.addMessage(sessionId, sysMsg);
              break;
            }
            case 'task_completed':
              if (data.planId && data.taskId) {
                const store = useAppStore.getState();
                store.updateTaskStatus(data.planId, data.taskId, 'done');
                if (data.agentName) {
                  useAppStore.setState(s => ({
                    agentCurrentTask: { ...s.agentCurrentTask, [data.agentName]: null },
                  }));
                }
              }
              break;
            case 'task_failed':
              if (data.planId && data.taskId) {
                const store = useAppStore.getState();
                store.updateTaskStatus(data.planId, data.taskId, 'failed');
                if (data.agentName) {
                  useAppStore.setState(s => ({
                    agentCurrentTask: { ...s.agentCurrentTask, [data.agentName]: null },
                  }));
                }
              }
              break;
            case 'task_blocked':
              if (data.planId && data.taskId) {
                const store = useAppStore.getState();
                store.updateTaskStatus(data.planId, data.taskId, 'blocked');
              }
              break;
            case 'replan_required':
              if (data.planId && data.taskId) {
                const replanStore = useAppStore.getState();
                // Update the task status to reflect it needs manual intervention
                replanStore.updateTaskField(data.planId, data.taskId, 'lastError', data.failedTask?.error || 'Replan required');
                // Show a system message to notify the user
                const replanMsg: Message = {
                  id: 'replan-' + Date.now(),
                  sessionId,
                  senderType: 'agent',
                  content: `## Replan Required\n\nTask "${data.failedTask?.title || data.taskId}" has failed after ${data.failedTask?.retryCount || 'multiple'} retries.\n\nError: ${data.failedTask?.error || 'Unknown error'}\n\nClick "让 Main Agent 重新规划" on the failed task node to request a new plan.`,
                  status: 'done',
                  createdAt: new Date().toISOString(),
                };
                replanStore.addMessage(sessionId, replanMsg);
              }
              break;
            case 'manager_reviewing':
              // Main Agent is analyzing the failure — frontend may show a spinner/indicator
              break;
            case 'manager_decision':
              if (data.planId && data.taskId) {
                const mdStore = useAppStore.getState();
                const mdMsg: Message = {
                  id: 'md-' + Date.now(),
                  sessionId,
                  senderType: 'agent',
                  content: `## Main Agent Decision\n\nTask **${data.taskId}**: **${data.decision}**\n\nReason: ${data.reason}`,
                  status: 'done',
                  createdAt: new Date().toISOString(),
                };
                mdStore.addMessage(sessionId, mdMsg);
              }
              break;
            case 'plan_summary': {
              const store = useAppStore.getState();
              store.setPlanSummary(sessionId, data.planId, {
                total: data.total ?? 0,
                completed: data.completed ?? 0,
                failed: data.failed ?? 0,
                fileChanges: data.fileChanges ?? [],
                timestamp: Date.now(),
              });
              break;
            }
            case 'skill_use':
              if (data.agentMessageId) {
                const store = useAppStore.getState();
                store.addAgentEvent(data.agentMessageId, {
                  id: data.agentMessageId + '-skill-' + Date.now(),
                  type: 'skill_use',
                  timestamp: data.timestamp || Date.now(),
                  agentId: data.agentId,
                  details: { skillName: data.skillName },
                } as any);
              }
              break;
            case 'diff_summary':
              if (data.files?.length) {
                addDiffCard(sessionId, {
                  id: data.id || 'diff-' + Date.now(),
                  sessionId,
                  agentMessageId: data.agentMessageId,
                  title: data.title || 'File changes',
                  files: data.files,
                  createdAt: data.createdAt || Date.now(),
                });
              }
              break;
            case 'deployment_status':
              if (data.deploymentId) {
                upsertDeploymentCard(sessionId, {
                  deploymentId: data.deploymentId,
                  target: data.target || 'docker',
                  status: data.status || 'queued',
                  log: data.log,
                  url: data.url,
                  imageSha: data.imageSha,
                  buildTimeMs: data.buildTimeMs,
                  error: data.error,
                  timestamp: data.timestamp,
                });
              }
              break;
            case 'test_report':
              if (data.report) {
                addTestReport(sessionId, {
                  id: 'test-' + Date.now(),
                  report: data.report,
                  exitCode: data.exitCode ?? 0,
                  timestamp: data.timestamp || Date.now(),
                });
              }
              break;
            case 'review_report':
              if (data.report) {
                addReviewReport(sessionId, {
                  id: 'rev-' + Date.now(),
                  report: data.report,
                  timestamp: data.timestamp || Date.now(),
                });
              }
              break;
            case 'plan_recovery_available':
              {
                const store = useAppStore.getState();
                const existing = store.planRecoveries[sessionId] ?? [];
                store.setRecoveryPlans(sessionId, [...existing, {
                  planId: data.planId,
                  planTitle: data.planTitle || 'Unknown Plan',
                  pendingCount: data.pendingCount,
                  pendingTasks: data.pendingTasks ?? [],
                }]);
              }
              break;
            case 'plan_recovery_confirmed':
              useAppStore.getState().removeRecoveryPlan(sessionId, data.planId);
              break;
            case 'plan_recovery_discarded':
              useAppStore.getState().removeRecoveryPlan(sessionId, data.planId);
              break;
            case 'comm_log':
              if (data.entry) {
                window.dispatchEvent(new CustomEvent('comm_log', { detail: data.entry }));
              }
              break;
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        socketPool.delete(sessionId);
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = (evt) => {
        console.log('[WS] Connection closed:', evt.code, evt.reason);
        if (socketPool.get(sessionId) === ws) socketPool.delete(sessionId);
        // Auto-reconnect on non-manual close (not 1000=normal, 4001=user not found, 4003=access denied)
        if (evt.code !== 1000 && evt.code !== 4001 && evt.code !== 4003) {
          setTimeout(() => {
            if (sessionId === useAppStore.getState().activeSessionId) {
              ensureConnection().catch(() => {});
            }
          }, 3000);
        }
      };
    });
  }, [sessionId, token, appendToMessage, setMessageStatus, addAgentEvent, removeStreamingMessage, addToast]);

  const send = useCallback(async (content: string, mentionedAgents: MentionTag[] = [], mode?: 'parallel' | 'sequential', quoteReferenceId?: string | null) => {
    const msgId = 'temp-' + Date.now();
    const userMsg: Message = {
      id: msgId,
      sessionId,
      senderType: 'human',
      content,
      status: 'sending',
      createdAt: new Date().toISOString(),
    };
    addMessage(sessionId, userMsg);

    // Build mentions from explicit tags or parse from text
    let mentions: { agentId: string; agentName: string; subPrompt: string }[];
    if (mentionedAgents.length > 0) {
      const { broadcastContext } = parseMentions(content, mentionableAgents);
      mentions = mentionedAgents.map((tag) => {
        const subPrompt = broadcastContext ? `${broadcastContext}\n\n${content}` : content;
        return { agentId: tag.agentId, agentName: tag.agentName, subPrompt };
      });
    } else {
      const parsed = parseMentions(content, mentionableAgents);
      mentions = parsed.mentions.length > 0 ? parsed.mentions : [];
    }

    try {
      const result = await api.sendMessage(sessionId, content, mentions.length > 0 ? mentions : undefined);

      // Replace temp message with real message from API response
      if (result.userMessageId) {
        // Remove temp message and add the real one
        useAppStore.getState().deleteMessage(sessionId, msgId);
        addMessage(sessionId, {
          id: result.userMessageId,
          sessionId,
          senderType: 'human',
          content,
          status: 'done',
          createdAt: new Date().toISOString(),
        });
      } else {
        // Fallback: keep the temp message but mark it as done
        setMessageStatus(sessionId, msgId, 'done');
      }

      for (const am of result.agentMessages) {
        const agentMsg: Message = {
          id: am.agentMessageId,
          sessionId,
          senderType: 'agent',
          agentId: am.agentId || undefined,
          content: '',
          status: 'streaming',
          createdAt: new Date().toISOString(),
        };
        addMessage(sessionId, agentMsg);
        addStreamingMessage(sessionId, am.agentMessageId);
      }

      const ws = await ensureConnection();
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
      }));
    } catch (err: any) {
      console.error('[WS] Failed to send message:', err);
      setMessageStatus(sessionId, msgId, 'error');
      addToast(err.message || 'Failed to send message', 'error');
    }
  }, [sessionId, agents, trustMode, orchestrationMode, addMessage, addStreamingMessage, ensureConnection, setMessageStatus, addToast]);

  const deleteMessage = useCallback(async (msgId: string) => {
    try {
      await api.deleteMessage(msgId);
    } catch (err: any) {
      console.error('[API] Failed to delete message:', err);
    }
    useAppStore.getState().deleteMessage(sessionId, msgId);
  }, [sessionId]);

  const regenerate = useCallback(async (agentMessageId: string) => {
    const state = useAppStore.getState();
    const sessionMsgs = state.messages[sessionId] ?? [];
    const agentMsgIndex = sessionMsgs.findIndex((m) => m.id === agentMessageId);
    if (agentMsgIndex < 0) return;

    // Find the most recent human message before this agent message
    let prevHumanMsg: Message | null = null;
    for (let i = agentMsgIndex - 1; i >= 0; i--) {
      if (sessionMsgs[i].senderType === 'human') {
        prevHumanMsg = sessionMsgs[i];
        break;
      }
    }
    if (!prevHumanMsg) return;

    // Re-send the previous user message
    await send(prevHumanMsg.content);
  }, [sessionId, send]);

  const respondToPermission = useCallback(async (permissionId: string, allowed: boolean) => {
    try {
      const ws = await ensureConnection();
      ws.send(JSON.stringify({
        type: 'permission_response',
        permissionId,
        allowed,
      }));
    } catch (err) {
      console.error('[WS] Failed to send permission response:', err);
    }
  }, [ensureConnection]);

  const sendReplan = useCallback(async (planId: string, taskId: string) => {
    try {
      const ws = await ensureConnection();
      ws.send(JSON.stringify({
        type: 'replan_failed_task',
        planId,
        taskId,
      }));
    } catch (err) {
      console.error('[WS] Failed to send replan request:', err);
      addToast('Failed to request re-plan', 'error');
    }
  }, [ensureConnection, addToast]);

  const forceCompleteTask = useCallback(async (planId: string, taskId: string) => {
    try {
      const ws = await ensureConnection();
      ws.send(JSON.stringify({
        type: 'force_complete_task',
        planId,
        taskId,
      }));
    } catch (err) {
      console.error('[WS] Failed to force-complete task:', err);
      addToast('Failed to force-complete task', 'error');
    }
  }, [ensureConnection, addToast]);

  const forceFailTask = useCallback(async (planId: string, taskId: string) => {
    try {
      const ws = await ensureConnection();
      ws.send(JSON.stringify({
        type: 'force_fail_task',
        planId,
        taskId,
        reason: 'Manually failed by user',
      }));
    } catch (err) {
      console.error('[WS] Failed to force-fail task:', err);
      addToast('Failed to force-fail task', 'error');
    }
  }, [ensureConnection, addToast]);

  const confirmPlan = useCallback(async (planId: string) => {
    try {
      const ws = await ensureConnection();
      const store = useAppStore.getState();
      const planSid = store.planSessionMap[planId] ?? sessionId;
      const tasks = store.taskPlans[planSid]?.[planId] || [];
      ws.send(JSON.stringify({
        type: 'confirm_plan',
        planId,
        tasks: tasks.map((t: any) => ({
          taskId: t.taskId,
          title: t.title,
          description: t.description || '',
          agentType: t.agentType,
          dependsOn: t.dependsOn || [],
          expectedOutput: t.expectedOutput || '',
          priority: t.priority || 'medium',
        })),
      }));
    } catch (err) {
      console.error('[WS] Failed to confirm plan:', err);
    }
  }, [ensureConnection]);

  const stopAgent = useCallback(async (agentMessageId: string) => {
    try {
      const ws = await ensureConnection();
      ws.send(JSON.stringify({ type: 'stop_agent', agentMessageId }));
      removeStreamingMessage(sessionId, agentMessageId);
    } catch (err) {
      console.error('[WS] Failed to stop agent:', err);
    }
  }, [sessionId, ensureConnection, removeStreamingMessage]);

  const connect = useCallback(() => {
    ensureConnection().catch((err) => console.error('[WS] Connect failed:', err));
  }, [ensureConnection]);

  useEffect(() => {
    if (sessionId) connect();
  }, [sessionId, connect]);

  return { send, connect, ensureConnection, stopAgent, respondToPermission, confirmPlan, deleteMessage, regenerate, sendReplan, forceCompleteTask, forceFailTask };
}
