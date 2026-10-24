import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RepoCardsView } from '../../../src/app/renderer/views/RepoCardsView.js';
import type { RepoCard } from '../../../src/core/types.js';
import { fakeApi, OVERVIEW } from './fake-api.js';

function card(over: Partial<RepoCard> = {}): RepoCard {
  return { repoId: 1, fullName: 'TETRA2000/a', status: 'ok', error: null, critical: 2, high: 3, open: 5, oldestOpenAlert: '2026-04-24T00:00:00.000Z', ...over };
}

function setup(cards: RepoCard[]) {
  const listRepoCards = vi.fn(async () => cards);
  const onOpenRepo = vi.fn();
  render(<RepoCardsView api={fakeApi({ listRepoCards })} overview={OVERVIEW} snapshotId={7} onOpenRepo={onOpenRepo} />);
  return { listRepoCards, onOpenRepo };
}

describe('RepoCardsView', () => {
  it('shows the vital signs of a repo with alerts and opens it on click', async () => {
    const { listRepoCards, onOpenRepo } = setup([card({ repoId: 4 })]);
    const button = await screen.findByRole('button', { name: /TETRA2000\/a/ });
    expect(listRepoCards).toHaveBeenCalledWith(7);
    expect(button).toHaveTextContent('Critical 2');
    expect(button).toHaveTextContent('High 3');
    expect(button).toHaveTextContent('Open 5');
    expect(button).toHaveTextContent('Reachable —');
    expect(button).toHaveTextContent('Oldest open alert: 6 months');
    await userEvent.click(button);
    expect(onOpenRepo).toHaveBeenCalledWith(4);
  });

  it('shows a not-monitored repo without counts and not clickable', async () => {
    setup([card({ status: 'not_monitored', critical: 0, high: 0, open: 0, oldestOpenAlert: null })]);
    expect(await screen.findByText('Not monitored')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Critical|Open/)).toBeNull();
  });

  it('shows an error repo with its message and no counts', async () => {
    setup([card({ status: 'error', error: 'boom <img src=x>', critical: 0, high: 0, open: 0, oldestOpenAlert: null })]);
    expect(await screen.findByText("Couldn't be read: boom <img src=x>")).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Critical|Open/)).toBeNull();
  });

  it('shows a clean repo as having no open alerts, not clickable', async () => {
    setup([card({ critical: 0, high: 0, open: 0, oldestOpenAlert: null })]);
    expect(await screen.findByText('No open alerts')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the repo name as text', async () => {
    setup([card({ fullName: 'x/<img src=x>' })]);
    expect(await screen.findByText(/x\/<img src=x>/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows a load failure in an alert', async () => {
    const listRepoCards = vi.fn(async () => {
      throw new Error("Error invoking remote method 'x': Error: nope");
    });
    render(<RepoCardsView api={fakeApi({ listRepoCards })} overview={OVERVIEW} snapshotId={7} onOpenRepo={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load repos: nope");
  });
});
