import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { AvatarUpload } from './AvatarUpload';
import { RuntimeConfigForm } from './RuntimeConfigForm';
import { useSettings } from '../hooks/useSettings';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<'profile' | 'agent'>('profile');
  const { fetchSettings, loading } = useSettings();

  useEffect(() => {
    if (open) fetchSettings();
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-80 bg-hub-surface border-l border-hub z-50 flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-hub">
          <h2 className="text-[13px] font-semibold text-hub-primary">Settings</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-hub-hover text-hub-tertiary">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex border-b border-hub">
          {[
            { key: 'profile', label: 'Profile' },
            { key: 'agent', label: 'Agent Config' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key as 'profile' | 'agent')}
              className={`flex-1 py-2.5 text-[11px] font-medium transition ${
                tab === t.key
                  ? 'text-hub-accent border-b-2 border-hub-accent'
                  : 'text-hub-muted hover:text-hub-secondary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-hub-muted text-[11px]">Loading...</div>
          ) : tab === 'profile' ? (
            <AvatarUpload />
          ) : (
            <RuntimeConfigForm />
          )}
        </div>
      </div>
    </>
  );
}
