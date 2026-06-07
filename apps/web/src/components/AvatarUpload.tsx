import { useState, useRef } from 'react';
import { useSettings } from '../hooks/useSettings';
import { useAppStore } from '../store/appStore';

export function AvatarUpload() {
  const { uploadAvatar } = useSettings();
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      setError('File too large (max 2MB)');
      return;
    }
    setUploading(true);
    setError('');
    const url = await uploadAvatar(file);
    setUploading(false);
    if (url) {
      // Sync avatar URL to appStore so SessionList sidebar updates immediately
      if (user) setUser({ ...user, avatarUrl: url });
    } else {
      setError('Upload failed');
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div
        className="w-20 h-20 rounded-full overflow-hidden border-2 cursor-pointer hover:opacity-80 transition relative"
        style={{ borderColor: 'var(--border-subtle)' }}
        onClick={() => inputRef.current?.click()}
      >
        {user?.avatarUrl ? (
          <img src={user.avatarUrl} alt="avatar" className="w-full h-full object-cover" />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-2xl font-bold"
            style={{ background: 'var(--bg-raised)', color: 'var(--text-tertiary)' }}
          >
            ?
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <span className="text-[11px] text-hub-muted">Click to change avatar (PNG/JPG, max 2MB)</span>
      {error && <span className="text-[11px] text-hub-danger">{error}</span>}
    </div>
  );
}
