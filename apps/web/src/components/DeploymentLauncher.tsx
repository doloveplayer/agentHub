import { useState } from 'react';
import { Rocket } from 'lucide-react';
import { api } from '../lib/api';

export function DeploymentLauncher({ sessionId }: { sessionId: string }) {
  const [target, setTarget] = useState<'docker' | 'vercel' | 'cloudflare'>('docker');
  const [production, setProduction] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [busy, setBusy] = useState(false);

  const deploy = async () => {
    setBusy(true);
    try {
      await api.generateDeployConfig(sessionId, {});
      await api.deployToPlatform(sessionId, { target, production, confirmPhrase });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Rocket className="h-4 w-4 text-slate-500" />
      <select
        value={target}
        onChange={(event) => setTarget(event.target.value as 'docker' | 'vercel' | 'cloudflare')}
        className="h-8 rounded border border-white/10 bg-slate-900 px-2 text-xs text-slate-200"
      >
        <option value="docker">Docker</option>
        <option value="vercel">Vercel</option>
        <option value="cloudflare">Cloudflare</option>
      </select>
      <label className="flex items-center gap-1 text-xs text-slate-400">
        <input type="checkbox" checked={production} onChange={(event) => setProduction(event.target.checked)} />
        Production
      </label>
      {production && (
        <input
          value={confirmPhrase}
          onChange={(event) => setConfirmPhrase(event.target.value)}
          placeholder={`DEPLOY ${target.toUpperCase()}`}
          className="h-8 rounded border border-white/10 bg-slate-900 px-2 text-xs text-slate-200"
        />
      )}
      <button
        onClick={deploy}
        disabled={busy || (production && confirmPhrase !== `DEPLOY ${target.toUpperCase()}`)}
        className="h-8 rounded bg-sky-600 px-3 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        Deploy
      </button>
    </div>
  );
}
