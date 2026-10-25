import { useEffect, useRef, useState } from 'react';
import type { RepoCard } from '../../../core/types.js';
import { formatAge, ipcErrorMessage } from '../format';
import type { ViewProps } from './types';

export function RepoCardsView({ api, overview, snapshotId, onOpenRepo }: ViewProps & { onOpenRepo: (repoId: number) => void }) {
  const [cards, setCards] = useState<RepoCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    const id = ++latestRequest.current;
    api.listRepoCards(snapshotId).then(
      (c) => {
        if (id !== latestRequest.current) return;
        setCards(c);
        setError(null);
      },
      (err: unknown) => {
        if (id !== latestRequest.current) return;
        setError(ipcErrorMessage(err));
      },
    );
  }, [api, snapshotId]);

  const now = overview.snapshot?.finishedAt ?? '';

  return (
    <section>
      <h2>Repos</h2>
      {error !== null && <p role="alert">{`Couldn't load repos: ${error}`}</p>}
      {cards !== null && (
        <ul className="repo-cards">
          {cards.map((c) => (
            <li key={c.repoId}>
              <CardBody card={c} now={now} onOpenRepo={onOpenRepo} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CardBody({ card, now, onOpenRepo }: { card: RepoCard; now: string; onOpenRepo: (repoId: number) => void }) {
  if (card.status === 'not_monitored') {
    return (
      <div className="repo-card">
        <strong className="name">{card.fullName}</strong>
        <span className="status">Not monitored</span>
      </div>
    );
  }
  if (card.status === 'error') {
    return (
      <div className="repo-card">
        <strong className="name">{card.fullName}</strong>
        <span className="status">{`Couldn't be read: ${card.error ?? 'unknown error'}`}</span>
      </div>
    );
  }
  if (card.open === 0) {
    return (
      <div className="repo-card">
        <strong className="name">{card.fullName}</strong>
        <span className="status">No open alerts</span>
      </div>
    );
  }
  return (
    <button type="button" className="repo-card" onClick={() => onOpenRepo(card.repoId)}>
      <strong className="name">{card.fullName}</strong>
      <span className="counts">
        <span>{`Critical ${card.critical}`}</span>
        <span>{`High ${card.high}`}</span>
        <span>{`Open ${card.open}`}</span>
        <span>Reachable —</span>
      </span>
      {card.oldestOpenAlert !== null && <span className="age">{`Oldest open alert: ${formatAge(card.oldestOpenAlert, now)}`}</span>}
    </button>
  );
}
