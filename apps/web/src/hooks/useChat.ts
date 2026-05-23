import { useCallback, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import type { AgentEvent } from '../store/appStore';
import { api } from '../lib/api';
import { parseMentions } from '../lib/mentionParser';
import type { Message, AgentConfig } from '@agenthub/shared';

const socketPool = new Map<string, WebSocket>();

interface MentionTag {
  agentId: string;
  agentName: string;
  displayName: string;
}

export function useChat(sessionId: string) {
  const token = useAppStore((s) => s.token);
  const agents = useAppStore((s) => s.agents);
  const trustMode = useAppStore((s) => s.trustMode);
  const orchestrationMode = useAppStore((s) => s.orchestrationMode);
  const { addMessage, appendToMessage, setMessageStatus, addAgentEvent, addStreamingMessage, removeStreamingMessage, setTaskPlan, incrementUnread } = useAppStore();

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
              appendToMessage(sessionId, data.agentMessageId, data.content);
              // Increment unread for inactive sessions (different tab)
              if (useAppStore.getState().activeSessionId !== sessionId) {
                incrementUnread(sessionId);
              }
              break;
            case 'stream_end': {
              // Fallback: populate content from fullContent if no stream_chunks arrived.
              // The backend sends fullContent as accumulated text or a fallback placeholder.
              if (data.fullContent) {
                const state = useAppStore.getState();
                const msg = state.messages[sessionId]?.find(m => m.id === data.agentMessageId);
                if (msg && !msg.content) {
                  appendToMessage(sessionId, data.agentMessageId, data.fullContent);
                }
              }
              setMessageStatus(sessionId, data.agentMessageId, data.exitCode === 0 ? 'done' : 'error');
              removeStreamingMessage(sessionId, data.agentMessageId);
              break;
            }
            case 'stream_error':
              console.error('[WS] Agent error:', data.error || data.message);
              if (data.agentMessageId) {
                setMessageStatus(sessionId, data.agentMessageId, 'error');
                removeStreamingMessage(sessionId, data.agentMessageId);
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
            case 'plan_result':
              if (data.planId && data.tasks) {
                setTaskPlan(data.planId, data.tasks);
              }
              break;
            case 'plan_executing':
              if (data.planId) {
                const tasks = useAppStore.getState().taskPlans[data.planId];
                if (tasks) {
                  setTaskPlan(data.planId, tasks.map((t: any) => ({ ...t, status: 'running' as const })));
                }
              }
              break;
            case 'task_assigned':
              if (data.planId && data.taskId && data.agentName) {
                const store = useAppStore.getState();
                store.setTaskAgent(data.planId, data.taskId, data.agentId, data.agentName);
              }
              break;
            case 'conflict_detected': {
              const cfStore = useAppStore.getState();
              const conflictFiles = (data.conflicts || []).map((c: any) =>
                `  • ${c.filePath} (${c.agents.join(', ')})`
              ).join('\n');
              const cfMsg: Message = {
                id: 'cf-' + Date.now(),
                sessionId,
                senderType: 'agent',
                content: `⚠️ 代码冲突检测：以下文件被多个 Agent 同时修改，请检查合并：\n${conflictFiles}`,
                status: 'done',
                createdAt: new Date().toISOString(),
              };
              cfStore.addMessage(sessionId, cfMsg);
              break;
            }
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
            case 'plan_summary': {
              const store = useAppStore.getState();
              store.setPlanSummary(data.planId, {
                total: data.total ?? 0,
                completed: data.completed ?? 0,
                failed: data.failed ?? 0,
                fileChanges: data.fileChanges ?? [],
                timestamp: Date.now(),
              });
              break;
            }
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
      };
    });
  }, [sessionId, token, appendToMessage, setMessageStatus, addAgentEvent, removeStreamingMessage]);

  const send = useCallback(async (content: string, mentionedAgents: MentionTag[] = [], mode?: 'parallel' | 'sequential') => {
    const userMsg: Message = {
      id: 'temp-' + Date.now(),
      sessionId,
      senderType: 'human',
      content,
      status: 'done',
      createdAt: new Date().toISOString(),
    };
    addMessage(sessionId, userMsg);

    // Build mentions from explicit tags or parse from text
    let mentions: { agentId: string; agentName: string; subPrompt: string }[];
    if (mentionedAgents.length > 0) {
      const { broadcastContext } = parseMentions(content, agents);
      mentions = mentionedAgents.map((tag) => {
        const subPrompt = broadcastContext ? `${broadcastContext}\n\n${content}` : content;
        return { agentId: tag.agentId, agentName: tag.agentName, subPrompt };
      });
    } else {
      const parsed = parseMentions(content, agents);
      mentions = parsed.mentions.length > 0 ? parsed.mentions : [];
    }

    try {
      const result = await api.sendMessage(sessionId, content, mentions.length > 0 ? mentions : undefined);

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
        trustMode,
        orchestrationMode: mode || orchestrationMode,
      }));
    } catch (err: any) {
      console.error('[WS] Failed to send message:', err);
    }
  }, [sessionId, agents, addMessage, addStreamingMessage, ensureConnection]);

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

  const confirmPlan = useCallback(async (planId: string, tasks: any[]) => {
    try {
      const ws = await ensureConnection();
      ws.send(JSON.stringify({
        type: 'confirm_plan',
        planId,
        tasks,
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

  return { send, connect, stopAgent, respondToPermission, confirmPlan };
}