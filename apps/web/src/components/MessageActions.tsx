import { useState, useRef, useEffect, useCallback } from 'react';
import { MoreHorizontal, Copy, Quote, RefreshCw, Trash2, Pin, Undo2, RotateCcw } from 'lucide-react';
import type { Message } from '@agenthub/shared';

interface Props {
  message: Message;
  agentDisplayName?: string;
  isGroupSession?: boolean;
  onCopy: () => void;
  onQuote: () => void;
  onPin: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onUndo?: () => void;
  onDeleteTurn?: () => void;
  onRegenerateTurn?: () => void;
}

export function MessageActions({ message, agentDisplayName, isGroupSession, onCopy, onQuote, onPin, onRegenerate, onDelete, onUndo, onDeleteTurn, onRegenerateTurn }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmTurnDelete, setConfirmTurnDelete] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const turnDeleteTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const closeMenu = useCallback(() => {
    setOpen(false);
    setConfirmDelete(false);
    setConfirmTurnDelete(false);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    if (turnDeleteTimerRef.current) clearTimeout(turnDeleteTimerRef.current);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      if (turnDeleteTimerRef.current) clearTimeout(turnDeleteTimerRef.current);
    };
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

  const handlePin = () => {
    onPin();
    closeMenu();
  };

  const handleRegenerate = () => {
    onRegenerate();
    closeMenu();
  };

  const handleUndo = () => {
    onUndo?.();
    closeMenu();
  };

  const handleRegenerateTurn = () => {
    onRegenerateTurn?.();
    closeMenu();
  };

  const handleTurnDelete = () => {
    if (!confirmTurnDelete) {
      setConfirmTurnDelete(true);
      turnDeleteTimerRef.current = setTimeout(() => setConfirmTurnDelete(false), 4000);
      return;
    }
    onDeleteTurn?.();
    closeMenu();
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 4000);
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
        <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-hub-surface border border-hub rounded-hub-lg shadow-xl py-1 animate-in fade-in zoom-in-95 origin-top-right">
          {isAgent && (
            <button onClick={handleCopy}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
              <Copy className="w-3.5 h-3.5" /> Copy
            </button>
          )}
          {isAgent && (
            <button onClick={handlePin}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
              <Pin className="w-3.5 h-3.5" /> Pin
            </button>
          )}
          {isAgent && (
            <button onClick={handleQuote}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
              <Quote className="w-3.5 h-3.5" /> Quote
            </button>
          )}
          {isAgent && (
            <>
              <div className="border-t border-hub my-1" />
              <button onClick={handleRegenerate}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
                <RefreshCw className="w-3.5 h-3.5" /> Regenerate
              </button>
            </>
          )}
          {isAgent && isGroupSession && (
            <button onClick={handleUndo}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
              <Undo2 className="w-3.5 h-3.5" /> Undo this agent
            </button>
          )}
          {onRegenerateTurn && (
            <>
              <div className="border-t border-hub my-1" />
              <button onClick={handleRegenerateTurn}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
                <RotateCcw className="w-3.5 h-3.5" /> Regenerate turn
              </button>
            </>
          )}
          {onDeleteTurn && (
            <button onClick={handleTurnDelete}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition ${
                confirmTurnDelete
                  ? 'text-hub-danger bg-hub-danger/10 hover:bg-hub-danger/20'
                  : 'text-hub-danger hover:bg-hub-hover'
              }`}>
              <Trash2 className="w-3.5 h-3.5" />
              {confirmTurnDelete ? 'Click to confirm delete turn' : 'Delete turn'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
