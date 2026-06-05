import { useState, useEffect, useCallback, useRef } from 'react';
import { Pin, PinOff, FileText, MessageSquare, Type, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '../lib/api';
import type { PinnedMessage } from '@agenthub/shared';

interface Props {
  sessionId: string;
  wsPinnedEvents: Array<{ type: string; pinned?: PinnedMessage; pinnedId?: string }>;
}

const SOURCE_ICONS: Record<string, typeof Pin> = {
  message: MessageSquare,
  file: FileText,
  text: Type,
};

const SOURCE_LABELS: Record<string, string> = {
  message: 'Message',
  file: 'File',
  text: 'Text',
};

export function PinnedPanel({ sessionId, wsPinnedEvents }: Props) {
  const [items, setItems] = useState<PinnedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const processedRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    processedRef.current = 0;
    api.getPinned(sessionId)
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    for (let i = processedRef.current; i < wsPinnedEvents.length; i++) {
      const event = wsPinnedEvents[i];
      if (event.type === 'pinned_added' && event.pinned) {
        setItems(prev => {
          if (prev.some(p => p.id === event.pinned!.id)) return prev;
          return [...prev, event.pinned!].sort((a, b) => a.sortOrder - b.sortOrder);
        });
      } else if (event.type === 'pinned_removed' && event.pinnedId) {
        setItems(prev => prev.filter(p => p.id !== event.pinnedId));
      } else if (event.type === 'pinned_updated' && event.pinned) {
        setItems(prev => prev.map(p => p.id === event.pinned!.id ? event.pinned! : p));
      }
    }
    processedRef.current = wsPinnedEvents.length;
  }, [wsPinnedEvents]);

  const handleDelete = useCallback(async (id: string) => {
    const prev = items;
    setItems(prev => prev.filter(p => p.id !== id));
    try {
      await api.deletePinned(sessionId, id);
    } catch {
      setItems(prev); // rollback
    }
  }, [sessionId, items]);

  const handleToggleInject = useCallback(async (id: string, current: boolean) => {
    setItems(prev => prev.map(p => p.id === id ? { ...p, injectToAgent: !current } : p));
    try {
      const updated = await api.updatePinned(sessionId, id, { injectToAgent: !current });
      setItems(prev => prev.map(p => p.id === id ? updated : p));
    } catch {
      setItems(prev => prev.map(p => p.id === id ? { ...p, injectToAgent: current } : p));
    }
  }, [sessionId]);

  if (loading) {
    return <div className="flex items-center justify-center py-8 text-hub-muted text-[11px]">Loading...</div>;
  }

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e]">
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {items.length === 0 ? (
          <div className="text-center text-hub-muted text-xs py-8">
            <Pin className="w-6 h-6 mx-auto mb-2 opacity-30" />
            <p>No pinned messages yet.</p>
            <p className="mt-1 text-[10px]">Use the + Pin button to pin messages, files, or text.</p>
          </div>
        ) : (
          items.map(item => {
            const Icon = SOURCE_ICONS[item.sourceType] ?? Pin;
            return (
              <div key={item.id} className="bg-hub-surface border border-hub rounded-lg p-3 group">
                <div className="flex items-start gap-2">
                  <Icon className="w-3.5 h-3.5 text-hub-accent mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-hub-muted uppercase">{SOURCE_LABELS[item.sourceType]}</span>
                      {item.title && (
                        <span className="text-xs text-hub-primary font-medium truncate">{item.title}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-hub-secondary mt-1 line-clamp-2 whitespace-pre-wrap">
                      {item.sourceType === 'file' ? item.filePath : item.content.slice(0, 150)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={() => handleToggleInject(item.id, item.injectToAgent)}
                      className="p-1 rounded hover:bg-hub-hover"
                      title={item.injectToAgent ? 'Disable agent injection' : 'Enable agent injection'}
                    >
                      {item.injectToAgent ? (
                        <ToggleRight className="w-4 h-4 text-hub-accent" />
                      ) : (
                        <ToggleLeft className="w-4 h-4 text-hub-muted" />
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="p-1 rounded hover:bg-hub-hover text-hub-danger"
                      title="Remove pin"
                    >
                      <PinOff className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
