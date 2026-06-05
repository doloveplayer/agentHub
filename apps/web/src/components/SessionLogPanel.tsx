import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import type { CommLogEntry, CommLogCategory } from '@agenthub/shared';

const CATEGORY_COLORS: Record<CommLogCategory, string> = {
  contextbus: 'text-blue-600',
  inbox: 'text-green-600',
  task: 'text-amber-600',
  plan: 'text-purple-600',
  agent: 'text-teal-600',
};

const CATEGORY_LABELS: Record<CommLogCategory, string> = {
  contextbus: 'CTX',
  inbox: 'INBOX',
  task: 'TASK',
  plan: 'PLAN',
  agent: 'AGENT',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function LogEntryRow({ entry }: { entry: CommLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const color = CATEGORY_COLORS[entry.category] || 'text-gray-400';
  const label = CATEGORY_LABELS[entry.category] || entry.category.toUpperCase();

  const detail = Object.entries(entry.payload)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');

  return (
    <div
      className="font-mono text-xs leading-5 px-3 py-0.5 hover:bg-hub-hover cursor-pointer border-b border-hub"
      onClick={() => setExpanded(!expanded)}
    >
      <span className="text-hub-tertiary">[{formatTime(entry.ts)}]</span>{' '}
      <span className={`${color} font-bold`}>[{label}]</span>{' '}
      <span className="text-hub-primary">{entry.action}</span>{' '}
      <span className="text-hub-secondary truncate inline-block max-w-[60vw] align-bottom">— {detail}</span>
      {expanded && (
        <pre className="mt-1 ml-6 p-2 bg-hub-input rounded text-[10px] text-hub-secondary whitespace-pre-wrap overflow-x-auto">
          {JSON.stringify(entry.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

interface Props {
  sessionId: string;
  wsEntries: CommLogEntry[]; // real-time entries from WebSocket
}

export function SessionLogPanel({ sessionId, wsEntries }: Props) {
  const [fileEntries, setFileEntries] = useState<CommLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Set<CommLogCategory>>(new Set(['contextbus', 'inbox', 'task', 'plan', 'agent']));
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Load historical entries on mount
  useEffect(() => {
    setLoading(true);
    api.getCommLog(sessionId)
      .then(({ entries }) => setFileEntries(entries))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  // Merge file entries + real-time WS entries, dedupe by ts
  const allEntries = React.useMemo(() => {
    const seen = new Set<number>();
    const merged: CommLogEntry[] = [];
    for (const e of [...fileEntries, ...wsEntries]) {
      if (!seen.has(e.ts)) {
        seen.add(e.ts);
        merged.push(e);
      }
    }
    merged.sort((a, b) => a.ts - b.ts);
    return merged;
  }, [fileEntries, wsEntries]);

  const filtered = React.useMemo(
    () => allEntries.filter(e => filters.has(e.category)),
    [allEntries, filters],
  );

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  }, []);

  const toggleFilter = (cat: CommLogCategory) => {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const categories: CommLogCategory[] = ['contextbus', 'inbox', 'task', 'plan', 'agent'];

  return (
    <div className="flex flex-col h-full bg-hub-root">
      {/* Filter bar */}
      <div className="flex items-center gap-3 px-3 py-2 bg-hub-surface border-b border-hub text-xs">
        <span className="text-hub-tertiary font-medium">Filter:</span>
        {categories.map(cat => (
          <label key={cat} className="flex items-center gap-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filters.has(cat)}
              onChange={() => toggleFilter(cat)}
              className="accent-hub-accent w-3 h-3"
            />
            <span className={CATEGORY_COLORS[cat]}>{CATEGORY_LABELS[cat]}</span>
          </label>
        ))}
        <span className="ml-auto text-hub-tertiary">{filtered.length} entries</span>
      </div>

      {/* Log entries */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={handleScroll}
      >
        {loading && (
          <div className="text-gray-500 text-xs px-3 py-2">Loading...</div>
        )}
        {filtered.length === 0 && !loading && (
          <div className="text-gray-500 text-xs px-3 py-4 text-center">
            No communication logs yet. ContextBus operations, inbox messages, and task events will appear here.
          </div>
        )}
        {filtered.map((entry, i) => (
          <LogEntryRow key={`${entry.ts}-${i}`} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
