import { useEffect, useRef, useState } from 'react';
import type { ReportEntry } from '../../../core/types.js';
import { Markdown } from '../components/Markdown';
import { formatUtc, ipcErrorMessage } from '../format';
import type { ViewProps } from './types';

function label(r: ReportEntry): string {
  const what = r.kind === 'account' ? 'Account report' : `Repo chart: ${r.repoFullName ?? 'unknown repo'}`;
  return `${what} · snapshot ${r.snapshotId} · ${formatUtc(r.createdAt)}`;
}

export function ReportsView({ api, overview, snapshotId }: ViewProps) {
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latestRead = useRef(0);

  useEffect(() => {
    let current = true;
    api.listReports().then(
      (list) => { if (current) setReports(list); },
      (err: unknown) => { if (current) setError(ipcErrorMessage(err)); },
    );
    return () => { current = false; };
  }, [api]);

  useEffect(() => {
    const request = ++latestRead.current;
    if (selected === null) return;
    setText(null);
    api.readReport(selected).then(
      (t) => {
        if (request !== latestRead.current) return;
        setText(t);
        setError(null);
      },
      (err: unknown) => {
        if (request !== latestRead.current) return;
        setError(ipcErrorMessage(err));
      },
    );
  }, [api, selected]);

  async function generate(req: Parameters<typeof api.generateReport>[0]) {
    setBusy(true);
    try {
      const entry = await api.generateReport(req);
      setReports(await api.listReports());
      setSelected(entry.id);
      setError(null);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Reports</h2>
      <div className="report-actions">
        <button type="button" disabled={busy} onClick={() => void generate({ kind: 'account', snapshotId })}>
          Generate account report
        </button>
        <label>
          Repo
          <select value={repoId ?? ''} onChange={(e) => setRepoId(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">Choose a repo</option>
            {overview.repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy || repoId === null}
          onClick={() => repoId !== null && void generate({ kind: 'repo', snapshotId, repoId })}>
          Generate repo chart
        </button>
      </div>
      {error !== null && <p role="alert">{error}</p>}
      <ul className="report-list">
        {reports.map((r) => (
          <li key={r.id}>
            <button type="button" aria-pressed={r.id === selected} onClick={() => setSelected(r.id)}>{label(r)}</button>
          </li>
        ))}
      </ul>
      {selected !== null && text !== null && <Markdown source={text} />}
    </section>
  );
}
