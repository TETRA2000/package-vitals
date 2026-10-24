import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { QueueData } from '../../shared/api.js';
import type { FindingFilter, Severity } from '../../../core/types.js';
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

/** The queue opens on critical findings only. */
export const DEFAULT_QUEUE_FILTER: FindingFilter = { severities: ['critical'], repoId: null, ecosystem: null };

/** Every open alert of one repo, so a card with no criticals still opens to its alerts. */
export function repoQueueFilter(repoId: number): FindingFilter {
  return { severities: SEVERITIES.map((s) => s.value), repoId, ecosystem: null };
}

/** The filter is the App's state, so it survives switching views. */
export function QueueView({
  api,
  overview,
  snapshotId,
  filter,
  onFilterChange,
}: ViewProps & { filter: FindingFilter; onFilterChange: Dispatch<SetStateAction<FindingFilter>> }) {
  const { severities, repoId: repoFilter, ecosystem } = filter;
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
    if (repoFilter !== null && !overview.repos.some((r) => r.id === repoFilter)) onFilterChange((f) => ({ ...f, repoId: null }));
  }, [repoFilter, overview.repos, onFilterChange]);

  function toggle(severity: Severity) {
    onFilterChange((f) => {
      const current = f.severities;
      if (current.includes(severity)) return current.length > 1 ? { ...f, severities: current.filter((s) => s !== severity) } : f;
      return { ...f, severities: SEVERITIES.map((s) => s.value).filter((s) => s === severity || current.includes(s)) };
    });
  }

  const now = overview.snapshot?.finishedAt ?? '';
  const selected = data !== null && selectedIndex !== null ? (data.rows[selectedIndex] ?? null) : null;

  return (
    <section className="queue">
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
          <select
            value={repoFilter === null ? '' : String(repoFilter)}
            onChange={(e) => {
              const repoId = e.target.value === '' ? null : Number(e.target.value);
              onFilterChange((f) => ({ ...f, repoId }));
            }}
          >
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
          <select
            value={ecosystem ?? ''}
            onChange={(e) => {
              const value = e.target.value === '' ? null : e.target.value;
              onFilterChange((f) => ({ ...f, ecosystem: value }));
            }}
          >
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
