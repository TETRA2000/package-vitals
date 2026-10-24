import { useEffect, useRef, useState } from 'react';
import type { QueueData } from '../../shared/api.js';
import type { Severity } from '../../../core/types.js';
import { FindingList } from '../components/FindingList';
import { Notices } from '../components/Notices';
import { SidePanel } from '../components/SidePanel';
import { SummaryStrip } from '../components/SummaryStrip';
import { ipcErrorMessage } from '../format';
import type { ViewProps } from './types';

const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export function QueueView({
  api,
  overview,
  snapshotId,
  repoFilter,
  onRepoFilterChange,
}: ViewProps & { repoFilter: number | null; onRepoFilterChange: (repoId: number | null) => void }) {
  const [severities, setSeverities] = useState<Severity[]>(['critical']);
  const [ecosystem, setEcosystem] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    const id = ++latestRequest.current;
    api.listFindings({ snapshotId, filter: { severities, repoId: repoFilter, ecosystem } }).then(
      (d) => {
        if (id !== latestRequest.current) return;
        setData(d);
        setError(null);
        setSelectedIndex(null);
      },
      (err: unknown) => {
        if (id !== latestRequest.current) return;
        setError(ipcErrorMessage(err));
      },
    );
  }, [api, snapshotId, severities, repoFilter, ecosystem]);

  useEffect(() => {
    if (repoFilter !== null && !overview.repos.some((r) => r.id === repoFilter)) onRepoFilterChange(null);
  }, [repoFilter, overview.repos, onRepoFilterChange]);

  function toggle(severity: Severity) {
    setSeverities((current) =>
      current.includes(severity)
        ? current.length > 1
          ? current.filter((s) => s !== severity)
          : current
        : SEVERITIES.map((s) => s.value).filter((s) => s === severity || current.includes(s)),
    );
  }

  const now = overview.snapshot?.finishedAt ?? '';
  const selected = data !== null && selectedIndex !== null ? (data.rows[selectedIndex] ?? null) : null;

  return (
    <section>
      <h2>Queue</h2>
      <Notices monitoring={overview.monitoring} />
      <div className="filters">
        <fieldset>
          <legend>Severity</legend>
          {SEVERITIES.map((s) => (
            <label key={s.value}>
              <input
                type="checkbox"
                checked={severities.includes(s.value)}
                disabled={severities.length === 1 && severities.includes(s.value)}
                onChange={() => toggle(s.value)}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
        <label>
          Repo
          <select value={repoFilter === null ? '' : String(repoFilter)} onChange={(e) => onRepoFilterChange(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">All repos</option>
            {overview.repos.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ecosystem
          <select value={ecosystem ?? ''} onChange={(e) => setEcosystem(e.target.value === '' ? null : e.target.value)}>
            <option value="">All ecosystems</option>
            {overview.ecosystems.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error !== null && <p role="alert">{`Couldn't load findings: ${error}`}</p>}
      {data !== null && (
        <>
          <SummaryStrip counts={data.counts} />
          {data.rows.length === 0 ? (
            <p>No open alerts match these filters.</p>
          ) : (
            <div className="queue-layout">
              <FindingList rows={data.rows} selectedIndex={selectedIndex} onSelect={setSelectedIndex} now={now} />
              <SidePanel
                api={api}
                findingKey={selected === null ? null : { snapshotId: selected.snapshotId, repoId: selected.repoId, number: selected.number }}
                now={now}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
