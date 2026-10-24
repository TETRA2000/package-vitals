import { useEffect, useState } from 'react';
import { checkupWarning, formatCheckupSummary } from '../../../core/checkup/format.js';
import type { CheckupProgress, VitalsApi } from '../../shared/api.js';
import { ipcErrorMessage } from '../format';

export function CheckupButton({ api, running, onDone }: { api: VitalsApi; running: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CheckupProgress | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => api.onCheckupProgress(setProgress), [api]);

  async function start() {
    setBusy(true);
    setProgress(null);
    setSummary(null);
    setWarning(null);
    setError(null);
    try {
      const result = await api.startCheckup();
      if (result.ok) {
        setSummary(formatCheckupSummary(result.summary));
        setWarning(checkupWarning(result.summary));
        onDone();
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  let label = 'Run Checkup';
  if (busy) label = progress ? `Checking… ${progress.done} / ${progress.total} · ${progress.repo}` : 'Checking…';
  else if (running) label = 'Checkup running…';

  return (
    <div className="checkup">
      <button type="button" disabled={busy || running} onClick={() => void start()}>{label}</button>
      {summary !== null && <p>{summary}</p>}
      {warning !== null && <p>{warning}</p>}
      {error !== null && <p role="alert">{error}</p>}
    </div>
  );
}
