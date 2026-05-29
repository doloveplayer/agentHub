import { useEffect, useState } from 'react';
import { Link2, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';

interface QuoteRef {
  id: string;
  sourceMessageId: string;
  targetMessageId?: string;
  agentId?: string;
  selectionText: string;
  sourceType: string;
  createdAt: string;
}

interface Props {
  messageId: string;
}

export function InteractionHistory({ messageId }: Props) {
  const [quotedFrom, setQuotedFrom] = useState<QuoteRef[]>([]);
  const [quotedBy, setQuotedBy] = useState<QuoteRef[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api.getQuoteReferences(messageId).then((data: any) => {
      setQuotedFrom(data.quotedFrom || []);
      setQuotedBy(data.quotedBy || []);
    }).catch(() => {});
  }, [messageId]);

  if (quotedFrom.length === 0 && quotedBy.length === 0) return null;

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] text-hub-muted hover:text-hub-secondary transition"
      >
        <Link2 className="h-3 w-3" />
        {quotedFrom.length > 0 && `引用了 ${quotedFrom.length} 处`}
        {quotedFrom.length > 0 && quotedBy.length > 0 && ' · '}
        {quotedBy.length > 0 && `被 ${quotedBy.length} 处引用`}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1 rounded border border-hub bg-hub-input/50 p-2 text-[11px]">
          {quotedFrom.map((ref) => (
            <div key={ref.id} className="flex items-center gap-1 text-hub-tertiary">
              <ArrowRight className="h-3 w-3 rotate-180" />
              <span className="truncate max-w-60">&quot;{ref.selectionText.slice(0, 80)}&quot;</span>
              <span className="text-hub-muted">({ref.sourceType})</span>
            </div>
          ))}
          {quotedBy.map((ref) => (
            <div key={ref.id} className="flex items-center gap-1 text-hub-tertiary">
              <ArrowRight className="h-3 w-3" />
              <span>Agent 处理了引用</span>
              <span className="text-hub-muted">{new Date(ref.createdAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
