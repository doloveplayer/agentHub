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
  const { addMessage, appendToMessage, setMessageStatus, addAgentEvent, addStreamingMessage, removeStreamingMessage } = useAppStore();

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
              break;
            case 'stream_end':
              setMessageStatus(sessionId, data.agentMessageId, data.exitCode === 0 ? 'done' : 'error');
              removeStreamingMessage(sessionId, data.agentMessageId);
              break;
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

  const send = useCallback(async (content: string, mentionedAgents: MentionTag[] = []) => {
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

  return { send, connect, stopAgent, respondToPermission };
}