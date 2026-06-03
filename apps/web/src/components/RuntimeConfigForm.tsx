import { useState } from 'react';
import { useSettings } from '../hooks/useSettings';

const FIELDS = [
  { key: 'maxConcurrent', label: 'Max Concurrent Agents', min: 1, max: 20, hint: 'Global max simultaneous agents' },
  { key: 'perSessionMax', label: 'Max Agents Per Session', min: 1, max: 50, hint: 'Max active agents in one session' },
  {
    key: 'timeoutMs',
    label: 'Agent Timeout (seconds)',
    min: 10,
    max: 3600,
    hint: 'Timeout per agent execution',
    fmt: (v: number) => v / 1000,
    parse: (v: number) => v * 1000,
  },
  {
    key: 'queueTimeoutMs',
    label: 'Queue Timeout (seconds)',
    min: 10,
    max: 1800,
    hint: 'Max queue wait time',
    fmt: (v: number) => v / 1000,
    parse: (v: number) => v * 1000,
  },
  {
    key: 'contextTokenBudget',
    label: 'Context Token Budget',
    min: 2000,
    max: 50000,
    hint: 'Total token budget for context injection (pinned + state + experience)',
  },
];

export function RuntimeConfigForm() {
  const { runtime, isAdmin, saveRuntimeConfig } = useSettings();
  const [values, setValues] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);

  if (!isAdmin) {
    return <div className="text-[11px] text-hub-muted py-4">Only admins can modify runtime parameters.</div>;
  }

  const current = runtime || { maxConcurrent: 2, timeoutMs: 300000, queueTimeoutMs: 120000, perSessionMax: 8 };

  const getVal = (key: string) => {
    if (values[key] !== undefined) return values[key];
    const field = FIELDS.find((f) => f.key === key);
    const raw = current[key as keyof typeof current] as number;
    return field?.fmt ? field.fmt(raw) : raw;
  };

  const handleChange = (key: string, raw: number) => {
    const field = FIELDS.find((f) => f.key === key);
    setValues((prev) => ({ ...prev, [key]: field?.parse ? field.parse(raw) : raw }));
  };

  const handleSave = async () => {
    if (Object.keys(values).length === 0) return;
    const ok = await saveRuntimeConfig(values);
    if (ok) {
      setSaved(true);
      setValues({});
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="space-y-4 py-2">
      {FIELDS.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <label className="text-[11px] text-hub-secondary font-medium">{f.label}</label>
          <input
            type="number"
            min={f.min}
            max={f.max}
            value={getVal(f.key)}
            onChange={(e) => handleChange(f.key, Number(e.target.value))}
            className="bg-hub-raised border border-hub rounded px-3 py-1.5 text-[11px] text-hub-primary outline-none focus:border-hub-accent"
          />
          <span className="text-[10px] text-hub-muted">{f.hint}</span>
        </div>
      ))}
      <button
        onClick={handleSave}
        className="w-full py-2 rounded text-[11px] font-medium transition"
        style={{ background: 'var(--accent-primary)', color: '#fff' }}
      >
        {saved ? '✓ Saved' : 'Save Runtime Config'}
      </button>
    </div>
  );
}
