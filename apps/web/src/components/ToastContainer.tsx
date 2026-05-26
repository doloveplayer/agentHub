import { useAppStore } from '../store/appStore';
import { X } from 'lucide-react';

const EMPTY_TOASTS: never[] = [];

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts) || EMPTY_TOASTS;
  const removeToast = useAppStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 rounded-hub-lg border px-4 py-3 shadow-lg backdrop-blur-sm transition-all duration-150 ${
            toast.type === 'error'
              ? 'border-red-500/30 bg-red-950/90 text-red-200'
              : toast.type === 'success'
                ? 'border-green-500/30 bg-green-950/90 text-green-200'
                : 'border-sky-500/30 bg-sky-950/90 text-sky-200'
          }`}
        >
          <span className="flex-1 text-sm">{toast.message}</span>
          <button
            onClick={() => removeToast(toast.id)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-white/40 hover:bg-white/10 hover:text-white"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
