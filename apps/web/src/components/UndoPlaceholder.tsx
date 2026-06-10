import { Undo2 } from 'lucide-react';

interface UndoPlaceholderProps {
  agentDisplayName?: string;
  agentId: string;
  timestamp: string;
}

export function UndoPlaceholder({ agentDisplayName, agentId, timestamp }: UndoPlaceholderProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 mx-4 my-1 rounded-lg border border-dashed border-hub-border/50 bg-hub-surface/30 text-sm text-hub-muted italic">
      <Undo2 className="w-4 h-4 flex-shrink-0" />
      <span>
        {agentDisplayName || agentId} 的回复已被撤回
      </span>
      <span className="text-xs text-hub-muted/40 ml-auto">
        {new Date(timestamp).toLocaleTimeString()}
      </span>
    </div>
  );
}
