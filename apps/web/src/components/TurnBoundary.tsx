import { Hash } from 'lucide-react';

interface TurnBoundaryProps {
  turnNumber: number;
  isActive?: boolean;
  messageCount: number;
}

export function TurnBoundary({ turnNumber, isActive, messageCount }: TurnBoundaryProps) {
  return (
    <div className="flex items-center gap-3 my-4 px-2">
      <div className="flex-1 h-px bg-hub-border" />
      <div className="flex items-center gap-1.5 text-xs text-hub-muted whitespace-nowrap">
        <Hash className="w-3 h-3" />
        <span>Turn {turnNumber}</span>
        {isActive && <span className="w-1.5 h-1.5 rounded-full bg-hub-accent" />}
        {messageCount > 0 && (
          <span className="text-hub-muted/50">{messageCount} messages</span>
        )}
      </div>
      <div className="flex-1 h-px bg-hub-border" />
    </div>
  );
}
