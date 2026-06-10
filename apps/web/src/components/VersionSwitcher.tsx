import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import type { TurnVersion } from '@agenthub/shared';

interface VersionSwitcherProps {
  turnId: string;
  currentVersionTurnId: string;
  onSwitchVersion: (version: TurnVersion) => void;
}

export function VersionSwitcher({ turnId, currentVersionTurnId, onSwitchVersion }: VersionSwitcherProps) {
  const [versions, setVersions] = useState<TurnVersion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    api.getTurnVersions(turnId).then((res) => {
      const list: TurnVersion[] = res.versions;
      setVersions(list);
      const idx = list.findIndex((v) => v.turnId === currentVersionTurnId);
      if (idx >= 0) setCurrentIndex(idx);
    }).catch(() => {});
  }, [turnId, currentVersionTurnId]);

  if (versions.length <= 1) return null;

  const goTo = (index: number) => {
    if (index < 0 || index >= versions.length) return;
    setCurrentIndex(index);
    onSwitchVersion(versions[index]);
  };

  return (
    <div className="flex items-center justify-center gap-1 py-1">
      <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-hub-surface border border-hub-border text-xs">
        <button
          onClick={() => goTo(currentIndex - 1)}
          disabled={currentIndex === 0}
          className="p-0.5 hover:text-hub-accent disabled:opacity-30"
        >
          <ChevronLeft className="w-3 h-3" />
        </button>
        <span className="text-hub-muted min-w-[2rem] text-center">
          {currentIndex + 1}/{versions.length}
        </span>
        <button
          onClick={() => goTo(currentIndex + 1)}
          disabled={currentIndex === versions.length - 1}
          className="p-0.5 hover:text-hub-accent disabled:opacity-30"
        >
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
