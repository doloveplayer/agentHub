import { useState, useRef, useEffect, useCallback } from 'react';
import { MoreHorizontal, Copy, Quote, RefreshCw, Trash2 } from 'lucide-react';
import type { Message } from '@agenthub/shared';

interface Props {
  message: Message;
  agentDisplayName?: string;
  onCopy: () => void;
  onQuote: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}

export function MessageActions({ message, agentDisplayName, onCopy, onQuote, onRegenerate, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setConfirmDelete(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, closeMenu]);

  const isAgent = message.senderType === 'agent';

  const handleCopy = () => {
    onCopy();
    closeMenu();
  };

  const handleQuote = () => {
    onQuote();
    closeMenu();
  };

  const handleRegenerate = () => {
    onRegenerate();
    closeMenu();
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      // Auto-cancel after 4s
      setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    onDelete();
    closeMenu();
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:bg-hub-hover"
        title="More actions"
      >
        <MoreHorizontal className="w-3.5 h-3.5 text-hub-tertiary" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-hub-surface border border-hub rounded-hub-lg shadow-xl py-1 animate-in fade-in zoom-in-95 origin-top-right">
          {isAgent && (
            <button
              onClick={handleCopy}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy
            </button>
          )}
          {isAgent && (
            <button
              onClick={handleQuote}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition"
            >
              <Quote className="w-3.5 h-3.5" />
              Quote
            </button>
          )}
          {isAgent && (
            <>
              <div className="border-t border-hub my-1" />
              <button
                onClick={handleRegenerate}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Regenerate
              </button>
            </>
          )}
          <div className={isAgent ? 'border-t border-hub my-1' : ''} />
          <button
            onClick={handleDelete}
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
              confirmDelete
                ? 'text-hub-danger bg-hub-danger/10 hover:bg-hub-danger/20'
                : 'text-hub-danger hover:bg-hub-hover'
            }`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {confirmDelete ? 'Click to confirm' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}
