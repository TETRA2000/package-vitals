import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../src/app/renderer/App.js';
import type { CheckupResult, Overview, QueueData } from '../../../src/app/shared/api.js';
import type { FindingFilter, FindingRow, RepoCard } from '../../../src/core/types.js';
import { fakeApi, OVERVIEW } from './fake-api.js';

describe('App', () => {
  it('says there is no Checkup yet', async () => {
    const api = fakeApi({ getOverview: vi.fn(async () => ({ ...OVERVIEW, snapshot: null })) });
    render(<App api={api} />);
    expect(await screen.findByText('No Checkup yet. Run a Checkup to see your vitals.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Queue' })).not.toBeInTheDocument();
  });

  it('shows the snapshot it is reading', async () => {
    render(<App api={fakeApi()} />);
    expect(await screen.findByText('Snapshot 7 · TETRA2000 · completed 2026-10-24 05:07 UTC')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Queue' })).toBeInTheDocument();
  });

  it('switches views from the nav', async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);
    await screen.findByText(/Snapshot 7/);
    await user.click(screen.getByRole('button', { name: 'Repos' }));
    expect(screen.getByRole('heading', { name: 'Repos' })).toBeInTheDocument();
  });

  it('reloads the overview when the window regains focus', async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await screen.findByText(/Snapshot 7/);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.getOverview).toHaveBeenCalledTimes(2);
  });

  it('enables the button again when a Checkup fails after a mid-run refocus', async () => {
    const user = userEvent.setup();
    let fail: (r: CheckupResult) => void = () => {};
    const getOverview = vi.fn<() => Promise<Overview>>().mockResolvedValue(OVERVIEW);
    const api = fakeApi({
      getOverview,
      startCheckup: vi.fn(() => new Promise<CheckupResult>((res) => { fail = res; })),
    });
    render(<App api={api} />);
    await screen.findByText(/Snapshot 7/);
    await user.click(screen.getByRole('button', { name: 'Run Checkup' }));
    getOverview.mockResolvedValue({ ...OVERVIEW, checkupRunning: true });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    getOverview.mockResolvedValue(OVERVIEW);
    await act(async () => fail({ ok: false, message: 'Server Error (HTTP 500)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server Error (HTTP 500)');
    expect(screen.getByRole('button', { name: 'Run Checkup' })).toBeEnabled();
  });

  describe('the queue filter', () => {
    const overview: Overview = {
      ...OVERVIEW,
      repos: [{ id: 3, fullName: 'TETRA2000/c' }, { id: 4, fullName: 'TETRA2000/highs' }],
      ecosystems: ['npm', 'pip'],
    };
    const highsCard: RepoCard = {
      repoId: 4, fullName: 'TETRA2000/highs', status: 'ok', error: null, critical: 0, high: 2, open: 2, oldestOpenAlert: '2026-04-24T00:00:00.000Z',
    };
    function highRow(n: number): FindingRow {
      return {
        snapshotId: 7, repoId: 4, number: n, fullName: 'TETRA2000/highs', severity: 'high', ecosystem: 'npm', packageName: `pkg-${n}`,
        ghsaId: `GHSA-${n}`, summary: `Summary ${n}`, manifestPath: 'package.json', createdAt: '2026-04-24T00:00:00.000Z', triage: 'not_triaged',
      };
    }
    function setup() {
      // Repo 4 has only high alerts; the queue shows them only when high is ticked.
      const listFindings = vi.fn(async ({ filter }: { snapshotId: number; filter: FindingFilter }): Promise<QueueData> => ({
        rows: filter.repoId === 4 && filter.severities.includes('high') ? [highRow(1), highRow(2)] : [],
        counts: { critical: 0, notTriaged: 0, devOnly: null, reachable: null, uncertain: null },
      }));
      const api = fakeApi({ getOverview: vi.fn(async () => overview), listFindings, listRepoCards: vi.fn(async () => [highsCard]) });
      render(<App api={api} />);
      return { listFindings };
    }
    const nav = (name: string) => within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name });

    it('opens a repo card in the queue with every severity ticked', async () => {
      const user = userEvent.setup();
      const { listFindings } = setup();
      await screen.findByText(/Snapshot 7/);
      expect(listFindings).toHaveBeenLastCalledWith({ snapshotId: 7, filter: { severities: ['critical'], repoId: null, ecosystem: null } });
      // An ecosystem filter would hide the repo's alerts too, so opening a card clears it.
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Ecosystem' }), 'pip');
      await user.click(nav('Repos'));
      await user.click(await screen.findByRole('button', { name: /TETRA2000\/highs/ }));
      const list = await screen.findByRole('listbox', { name: 'Findings' });
      expect(listFindings).toHaveBeenLastCalledWith({
        snapshotId: 7,
        filter: { severities: ['critical', 'high', 'medium', 'low'], repoId: 4, ecosystem: null },
      });
      expect(within(list).getAllByRole('option')).toHaveLength(2);
      for (const name of ['Critical', 'High', 'Medium', 'Low']) expect(screen.getByRole('checkbox', { name })).toBeChecked();
    });

    it('keeps the chosen severities across view switches', async () => {
      const user = userEvent.setup();
      const { listFindings } = setup();
      await screen.findByText(/Snapshot 7/);
      await user.click(await screen.findByRole('checkbox', { name: 'High' }));
      await user.click(screen.getByRole('checkbox', { name: 'Critical' }));
      await user.click(nav('Repos'));
      await screen.findByRole('heading', { name: 'Repos' });
      await user.click(nav('Queue'));
      expect(await screen.findByRole('checkbox', { name: 'High' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Critical' })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'High' })).toBeDisabled();
      expect(listFindings).toHaveBeenLastCalledWith({ snapshotId: 7, filter: { severities: ['high'], repoId: null, ecosystem: null } });
    });
  });

  it("shows an error when the overview can't load", async () => {
    const api = fakeApi({ getOverview: vi.fn(async () => { throw new Error('boom'); }) });
    render(<App api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load data: boom");
  });

  describe('overlapping reloads', () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    const other = { ...OVERVIEW, snapshot: { ...OVERVIEW.snapshot!, id: 9 } };

    async function focus() {
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
    }

    it('shows the newer overview when responses arrive out of order', async () => {
      const first = deferred<Overview>();
      const second = deferred<Overview>();
      const getOverview = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(<App api={fakeApi({ getOverview })} />);
      await focus();
      await act(async () => second.resolve(other));
      await act(async () => first.resolve(OVERVIEW));
      expect(screen.getByText(/Snapshot 9/)).toBeInTheDocument();
      expect(screen.queryByText(/Snapshot 7/)).not.toBeInTheDocument();
    });

    it('ignores an older failure after a newer success', async () => {
      const first = deferred<Overview>();
      const second = deferred<Overview>();
      const getOverview = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(<App api={fakeApi({ getOverview })} />);
      await focus();
      await act(async () => second.resolve(OVERVIEW));
      await act(async () => first.reject(new Error('late')));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(/Snapshot 7/)).toBeInTheDocument();
    });

    it('clears an error when a later reload succeeds', async () => {
      const getOverview = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(OVERVIEW);
      render(<App api={fakeApi({ getOverview })} />);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      await focus();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText(/Snapshot 7/)).toBeInTheDocument();
    });
  });
});
