interface Props {
  agentName: string;
  displayName: string;
  status: 'running' | 'queued' | 'done' | 'idle';
  size?: number;
}

export function AgentAvatar({ agentName, displayName, status, size = 80 }: Props) {
  const isActive = status === 'running' || status === 'queued';
  const isSleep = !isActive;
  const statusColor =
    status === 'running' ? '#22c55e' :
    status === 'queued' ? '#eab308' :
    status === 'done' ? '#3b82f6' : '#9ca3af';
  const scale = size / 180;

  return (
    <div
      className="relative shrink-0 select-none"
      style={{ width: size, height: size }}
      title={`${displayName} - ${status}`}
    >
      {/* Base image */}
      <img
        src={isActive ? '/work.png' : '/sleep.png'}
        alt={status}
        style={{ width: size, height: size, objectFit: 'cover' }}
      />

      {/* Sleep overlay: Zzz */}
      {isSleep && (
        <div className="absolute inset-0 pointer-events-none">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute font-black animate-zzz"
              style={{
                right: `${8 + i * 12}%`,
                top: `${4 + i * 2}%`,
                fontSize: `${Math.round(26 * scale)}px`,
                animationDelay: `${i * 0.8}s`,
                fontFamily: 'Arial Black, Arial, sans-serif',
                color: '#4A2C1A',
                textShadow: '0 0 2px rgba(255,255,255,0.5)',
              }}
            >
              {i === 2 ? 'Z' : 'z'}
            </span>
          ))}
        </div>
      )}

      {/* Work overlay: keyboard typing dots */}
      {isActive && (
        <div className="absolute inset-0 pointer-events-none" style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: 180, height: 180 }}>
          {/* Keyboard press dots */}
          <div className="absolute flex gap-1.5" style={{ left: '38%', top: '50%' }}>
            <span className="w-2 h-2 rounded-full animate-type-dot" style={{ animationDelay: '0s', backgroundColor: '#4A2C1A', boxShadow: '0 0 2px rgba(74,44,26,0.5)' }} />
            <span className="w-2 h-2 rounded-full animate-type-dot" style={{ animationDelay: '0.2s', backgroundColor: '#4A2C1A', boxShadow: '0 0 2px rgba(74,44,26,0.5)' }} />
            <span className="w-2 h-2 rounded-full animate-type-dot" style={{ animationDelay: '0.4s', backgroundColor: '#4A2C1A', boxShadow: '0 0 2px rgba(74,44,26,0.5)' }} />
          </div>
        </div>
      )}

      {/* Status dot */}
      <div
        className="absolute z-20 rounded-full"
        style={{
          width: Math.max(5, size * 0.1),
          height: Math.max(5, size * 0.1),
          top: size * 0.02,
          right: size * 0.02,
          backgroundColor: statusColor,
          border: '1px solid #ffffff',
        }}
      />
    </div>
  );
}
