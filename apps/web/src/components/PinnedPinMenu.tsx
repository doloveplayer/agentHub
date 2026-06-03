import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageSquare, FileText, Type, Pin } from 'lucide-react';
import { api } from '../lib/api';
import type { Message } from '@agenthub/shared';

interface Props {
  sessionId: string;
  messages: Message[];
  onPinned: () => void;
}

type MenuMode = 'main' | 'message' | 'file' | 'text';

export function PinnedPinMenu({ sessionId, messages, onPinned }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<MenuMode>('main');
  const [searchQuery, setSearchQuery] = useState('');
  const [textContent, setTextContent] = useState('');
  const [textTitle, setTextTitle] = useState('');
  const [filePath, setFilePath] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setMode('main');
    setSearchQuery('');
    setTextContent('');
    setTextTitle('');
    setFilePath('');
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

  const handlePinMessage = useCallback(async (msg: Message) => {
    await api.createPinned(sessionId, {
      sourceType: 'message',
      content: msg.content,
      sourceMessageId: msg.id,
      title: msg.content.slice(0, 80).split('\n')[0],
    });
    onPinned();
    closeMenu();
  }, [sessionId, onPinned, closeMenu]);

  const handlePinFile = useCallback(async () => {
    if (!filePath.trim()) return;
    await api.createPinned(sessionId, {
      sourceType: 'file',
      content: filePath.trim(),
      filePath: filePath.trim(),
      title: filePath.trim().split('/').pop() ?? filePath.trim(),
    });
    onPinned();
    closeMenu();
  }, [sessionId, filePath, onPinned, closeMenu]);

  const handlePinText = useCallback(async () => {
    if (!textContent.trim()) return;
    await api.createPinned(sessionId, {
      sourceType: 'text',
      content: textContent.trim(),
      title: textTitle.trim() || textContent.trim().slice(0, 80),
    });
    onPinned();
    closeMenu();
  }, [sessionId, textContent, textTitle, onPinned, closeMenu]);

  const filteredMessages = messages
    .filter(m => m.senderType === 'agent' && m.status === 'done')
    .filter(m => !searchQuery || m.content.toLowerCase().includes(searchQuery.toLowerCase()))
    .slice(-50)
    .reverse();

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-[11px] text-hub-accent hover:bg-hub-hover rounded transition"
        title="Pin message, file, or text"
      >
        <Pin className="w-3 h-3" />
        + Pin
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-hub-surface border border-hub rounded-lg shadow-xl animate-in fade-in zoom-in-95 origin-top-right">
          {mode === 'main' && (
            <div className="py-1">
              <button onClick={() => setMode('message')} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
                <MessageSquare className="w-3.5 h-3.5" /> Pin Message
              </button>
              <button onClick={() => setMode('file')} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
                <FileText className="w-3.5 h-3.5" /> Pin File
              </button>
              <button onClick={() => setMode('text')} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-hub-secondary hover:bg-hub-hover transition">
                <Type className="w-3.5 h-3.5" /> Pin Text
              </button>
            </div>
          )}

          {mode === 'message' && (
            <div className="p-2">
              <div className="flex items-center gap-2 mb-2">
                <button onClick={() => setMode('main')} className="text-hub-muted hover:text-hub-secondary text-xs">&larr;</button>
                <input type="text" placeholder="Search messages..." value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="flex-1 bg-hub-raised border border-hub rounded px-2 py-1 text-xs text-hub-primary outline-none focus:border-hub-accent" autoFocus />
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {filteredMessages.length === 0 ? (
                  <div className="text-hub-muted text-[10px] text-center py-2">No messages found</div>
                ) : (
                  filteredMessages.map(msg => (
                    <button key={msg.id} onClick={() => handlePinMessage(msg)}
                      className="w-full text-left px-2 py-1.5 text-[11px] text-hub-secondary hover:bg-hub-hover rounded transition truncate">
                      {msg.content.slice(0, 100).replace(/\n/g, ' ')}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {mode === 'file' && (
            <div className="p-2 space-y-2">
              <div className="flex items-center gap-2">
                <button onClick={() => setMode('main')} className="text-hub-muted hover:text-hub-secondary text-xs">&larr;</button>
                <span className="text-xs text-hub-secondary">Pin File Path</span>
              </div>
              <input type="text" placeholder="/workspace/path/to/file" value={filePath}
                onChange={e => setFilePath(e.target.value)}
                className="w-full bg-hub-raised border border-hub rounded px-2 py-1.5 text-xs text-hub-primary outline-none focus:border-hub-accent" autoFocus />
              <button onClick={handlePinFile} disabled={!filePath.trim()}
                className="w-full py-1.5 rounded text-xs font-medium bg-hub-accent text-white disabled:opacity-50 transition">
                Pin File
              </button>
            </div>
          )}

          {mode === 'text' && (
            <div className="p-2 space-y-2">
              <div className="flex items-center gap-2">
                <button onClick={() => setMode('main')} className="text-hub-muted hover:text-hub-secondary text-xs">&larr;</button>
                <span className="text-xs text-hub-secondary">Pin Text</span>
              </div>
              <input type="text" placeholder="Title (optional)" value={textTitle}
                onChange={e => setTextTitle(e.target.value)}
                className="w-full bg-hub-raised border border-hub rounded px-2 py-1.5 text-xs text-hub-primary outline-none focus:border-hub-accent" />
              <textarea placeholder="Content to pin..." value={textContent}
                onChange={e => setTextContent(e.target.value)}
                className="w-full bg-hub-raised border border-hub rounded px-2 py-1.5 text-xs text-hub-primary outline-none focus:border-hub-accent resize-none h-20" autoFocus />
              <button onClick={handlePinText} disabled={!textContent.trim()}
                className="w-full py-1.5 rounded text-xs font-medium bg-hub-accent text-white disabled:opacity-50 transition">
                Pin Text
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
