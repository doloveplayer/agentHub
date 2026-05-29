import { Quote, X } from 'lucide-react';
import { buildQuotePrompt, type QuotePayload } from '../lib/quoteContext';

interface SelectionData {
  text: string;
  rect: { top: number; left: number; width: number; height: number };
  url: string;
}

interface Props {
  selection: SelectionData | null;
  onDismiss: () => void;
}

export function QuoteToolbar({ selection, onDismiss }: Props) {
  if (!selection || !selection.text) return null;

  const handleQuote = () => {
    const payload: QuotePayload = {
      text: selection.text,
      sourceType: 'preview',
      contextMeta: {},
    };
    const prompt = buildQuotePrompt(payload);
    window.dispatchEvent(new CustomEvent('agenthub:prompt-insert', { detail: { prompt } }));
    onDismiss();
  };

  return (
    <div
      className="absolute z-50 flex items-center gap-1 rounded-lg bg-hub-raised border border-hub shadow-lg px-2 py-1.5 animate-in fade-in zoom-in-95 duration-150"
      style={{ bottom: 60, right: 16 }}
    >
      <Quote className="h-3.5 w-3.5 text-hub-accent" />
      <span className="text-xs text-hub-primary max-w-48 truncate">
        {selection.text.slice(0, 60)}{selection.text.length > 60 ? '...' : ''}
      </span>
      <button
        onClick={handleQuote}
        className="ml-1 rounded bg-hub-accent px-2 py-0.5 text-[11px] font-medium text-white hover:bg-hub-accent-hover transition"
      >
        引用并交给 Agent
      </button>
      <button
        onClick={onDismiss}
        className="ml-0.5 text-hub-muted hover:text-hub-secondary transition"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
