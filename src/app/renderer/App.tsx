import { useCallback, useEffect, useRef, useState } from 'react';
import type { Overview, VitalsApi } from '../shared/api.js';
import { formatUtc, ipcErrorMessage } from './format';
import { QueueView } from './views/QueueView';
import { RepoCardsView } from './views/RepoCardsView';
import { ReportsView } from './views/ReportsView';
import { TreatmentPlanView } from './views/TreatmentPlanView';

type View = 'queue' | 'repos' | 'treatment' | 'reports';

const NAV: { view: View; label: string }[] = [
  { view: 'queue', label: 'Queue' },
  { view: 'repos', label: 'Repos' },
  { view: 'treatment', label: 'Treatment plan' },
  { view: 'reports', label: 'Reports' },
];

export function App({ api }: { api: VitalsApi }) {
  const [view, setView] = useState<View>('queue');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState<number | null>(null);

  const latestRequest = useRef(0);

  const reload = useCallback(() => {
    const id = ++latestRequest.current;
    api.getOverview().then(
      (o) => {
        if (id !== latestRequest.current) return;
        setOverview(o);
        setError(null);
      },
      (err: unknown) => {
        if (id !== latestRequest.current) return;
        setError(ipcErrorMessage(err));
      },
    );
  }, [api]);

  useEffect(() => {
    reload();
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);

  const snapshot = overview?.snapshot ?? null;

  function renderView(o: Overview, snapshotId: number) {
    const props = { api, overview: o, snapshotId };
    switch (view) {
      case 'queue':
        return <QueueView {...props} repoFilter={repoFilter} onRepoFilterChange={setRepoFilter} />;
      case 'repos':
        return (
          <RepoCardsView
            {...props}
            onOpenRepo={(repoId) => {
              setRepoFilter(repoId);
              setView('queue');
            }}
          />
        );
      case 'treatment':
        return <TreatmentPlanView {...props} />;
      case 'reports':
        return <ReportsView {...props} />;
    }
  }

  return (
    <div className="app">
      <header>
        <nav aria-label="Views">
          {NAV.map((n) => (
            <button key={n.view} type="button" aria-current={view === n.view ? 'page' : undefined} onClick={() => setView(n.view)}>
              {n.label}
            </button>
          ))}
        </nav>
        {snapshot && (
          <p className="snapshot">{`Snapshot ${snapshot.id} · ${snapshot.ownerLogin} · completed ${formatUtc(snapshot.finishedAt)}`}</p>
        )}
      </header>
      {error !== null && <p role="alert">{`Couldn't load data: ${error}`}</p>}
      <main>
        {overview !== null &&
          (snapshot === null ? <p>No Checkup yet. Run a Checkup to see your vitals.</p> : renderView(overview, snapshot.id))}
      </main>
    </div>
  );
}
