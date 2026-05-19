import { Square } from 'lucide-react';
import { agentColor } from './AgentMentionPopup';
import type { AgentEvent } from '../store/appStore';

interface Props {
  agentId: string;
  displayName: string;
  status: 'running' | 'done' | 'idle';
  events: AgentEvent[];
  thinkingLevel?: string;
  contextUsage?: string;
  files?: string[];
  onStop?: () => void;
}

const THINKING_LABELS: Record<string, string> = {
  'code-agent': 'high',
  'review-agent': 'standard',
  'devops-agent': 'standard',
};

export function AgentCard({ agentId, displayName, status, events, thinkingLevel, contextUsage, files, onStop }: Props) {
  const lastEvent = events[events.length - 1];
  const toolEvents = events.filter((e) => e.type === 'tool_use');
  const subagentEvents = events.filter((e) => e.type === 'subagent_start' || e.type === 'subagent_result');

  // Extract files from tool_use events
  const touchedFiles: string[] = files ?? [];
  if (touchedFiles.length === 0) {
    for (const ev of toolEvents) {
      const input = ev.details.input as Record<string, unknown> | undefined;
      if (input) {
        const path = (input.file_path || input.path || input.filePath) as string | undefined;
        if (path && !touchedFiles.includes(path)) touchedFiles.push(path);
      }
    }
  }

  const level = thinkingLevel ?? THINKING_LABELS[agentId] ?? 'standard';

  return (
    <div className="bg-gray-800/80 border border-gray-700 rounded-lg p-3 mb-2">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            status === 'running' ? 'bg-green-500 animate-pulse' :
            status === 'done' ? 'bg-green-500' : 'bg-gray-500'
          }`}
        />
        <span className="text-sm font-medium text-gray-200">{displayName}</span>
        {status === 'running' && onStop && (
          <button
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            className="ml-auto p-1 rounded hover:bg-red-900/50 text-red-400 hover:text-red-300 transition"
            title="Stop agent"
          >
            <Square className="w-3 h-3" />
          </button>
        )}
        {status !== 'running' && (
          <span className="ml-auto text-[10px] text-gray-500">{status}</span>
        )}
      </div>

      {status === 'running' && (
        <div className="mt-2 text-[11px] text-gray-400 space-y-0.5">
          <div className="flex justify-between">
            <span>Think</span><span className="text-gray-300">{level}</span>
          </div>
          {contextUsage && (
            <div className="flex justify-between">
              <span>Context</span><span className="text-gray-300">{contextUsage}</span>
            </div>
          )}
          {lastEvent && (
            <div className="flex justify-between">
              <span>Current</span>
              <span className="text-purple-400 truncate ml-2">
                {lastEvent.type === 'tool_use' && `${lastEvent.details.toolName ?? 'tool'}`}
                {lastEvent.type === 'tool_result' && 'Processing result...'}
                {lastEvent.type === 'subagent_start' && `Sub: ${lastEvent.details.agentType ?? '?'}`}
              </span>
            </div>
          )}
          {touchedFiles.length > 0 && (
            <div className="flex justify-between">
              <span>Files</span><span className="truncate ml-2">{touchedFiles.slice(0, 3).join(', ')}</span>
            </div>
          )}
        </div>
      )}

      {subagentEvents.length > 0 && (
        <div className="mt-2">
          {subagentEvents.slice(-3).map((ev, i) => (
            <div key={i} className="text-[10px] bg-gray-900/60 px-2 py-0.5 rounded mt-1 text-gray-400">
              {ev.type === 'subagent_start' ? '🔀' : '✅'} {ev.details.agentType ?? 'subagent'}
              {ev.type === 'subagent_result' && <span className="text-green-500 ml-1">done</span>}
            </div>
          ))}
        </div>
      )}

      {toolEvents.length > 0 && (
        <div className="mt-2 text-[10px] text-gray-500">
          {toolEvents.length} tool call{toolEvents.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
