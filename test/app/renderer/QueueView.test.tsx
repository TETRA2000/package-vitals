import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueueView } from '../../../src/app/renderer/views/QueueView.js';
import type { Overview, QueueCounts, QueueData } from '../../../src/app/shared/api.js';
import type { FindingRow } from '../../../src/core/types.js';
import { fakeApi, OVERVIEW } from './fake-api.js';

const COUNTS: QueueCounts = { critical: 1, notTriaged: 1, devOnly: null, reachable: null, uncertain: null };

function row(n: number, over: Partial<FindingRow> = {}): FindingRow {
  return {
    snapshotId: 7,
    repoId: 1,
    number: n,
    fullName: 'TETRA2000/a',
    severity: 'critical',
    ecosystem: 'npm',
    packageName: `pkg-${n}`,
    ghsaId: `GHSA-${n}`,
    summary: `Summary ${n}`,
    manifestPath: 'package.json',
    createdAt: '2026-04-24T00:00:00.000Z',
    triage: 'not_triaged',
    ...over,
  };
}

function setup(data: Partial<QueueData> = {}, overview: Overview = OVERVIEW, extra: { repoFilter?: number | null; onRepoFilterChange?: (id: number | null) => void } = {}) {
  const listFindings = vi.fn(async () => ({ rows: [], counts: COUNTS, ...data }));
  const api = fakeApi({ listFindings });
  const onRepoFilterChange = extra.onRepoFilterChange ?? vi.fn();
  const utils = render(
    <QueueView api={api} overview={overview} snapshotId={7} repoFilter={extra.repoFilter ?? null} onRepoFilterChange={onRepoFilterChange} />,
  );
  return { listFindings, onRepoFilterChange, ...utils };
}

/** The finding rows (the selects' <option>s share the role, so scope to the list). */
async function rows() {
  return within(await screen.findByRole('listbox', { name: 'Findings' })).findAllByRole('option');
}

describe('QueueView', () => {
  it('asks for critical findings by default', async () => {
    const { listFindings } = setup({ rows: [row(1)] });
    await rows();
    expect(listFindings).toHaveBeenCalledWith({ snapshotId: 7, filter: { severities: ['critical'], repoId: null, ecosystem: null } });
  });

  it('adds a severity when its box is ticked, and keeps at least one', async () => {
    const user = userEvent.setup();
    const { listFindings } = setup({ rows: [row(1)] });
    await rows();
    await user.click(screen.getByRole('checkbox', { name: 'High' }));
    expect(listFindings).toHaveBeenLastCalledWith({ snapshotId: 7, filter: { severities: ['critical', 'high'], repoId: null, ecosystem: null } });
    await user.click(screen.getByRole('checkbox', { name: 'Critical' }));
    expect(listFindings).toHaveBeenLastCalledWith({ snapshotId: 7, filter: { severities: ['high'], repoId: null, ecosystem: null } });
    expect(screen.getByRole('checkbox', { name: 'High' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Critical' })).toBeEnabled();
  });

  it('shows the summary strip, with — for counts not computed yet', async () => {
    setup({ counts: { critical: 524, notTriaged: 524, devOnly: null, reachable: null, uncertain: null } });
    expect(await screen.findByText('Critical 524')).toBeInTheDocument();
    expect(screen.getByText('Not triaged 524')).toBeInTheDocument();
    expect(screen.getByText('Dev-only —')).toBeInTheDocument();
    expect(screen.getByText('Reachable —')).toBeInTheDocument();
    expect(screen.getByText('Uncertain —')).toBeInTheDocument();
  });

  it('renders each row with its package, repo, advisory, and age at the snapshot', async () => {
    setup({ rows: [row(1)] });
    const option = (await rows())[0]!;
    expect(option).toHaveTextContent('critical');
    expect(option).toHaveTextContent('pkg-1 (npm)');
    expect(option).toHaveTextContent('TETRA2000/a');
    expect(option).toHaveTextContent('GHSA-1: Summary 1');
    expect(option).toHaveTextContent('6 months');
  });

  it('renders repo text as text', async () => {
    const { container } = setup({ rows: [row(1, { summary: '<img src=x onerror=alert(1)>', packageName: '<b>x</b>' })] });
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getByText(/<b>x<\/b> \(npm\)/)).toBeInTheDocument();
    expect(container.querySelector('img, b')).toBeNull();
  });

  it('renders only the visible rows of a long list', async () => {
    const many = Array.from({ length: 10000 }, (_, i) => row(i + 1));
    setup({ rows: many });
    await rows();
    const count = (await rows()).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);
  });

  it('lists not monitored and unreadable repos as notices, not rows', async () => {
    const overview: Overview = {
      ...OVERVIEW,
      monitoring: { checked: 3, monitored: 1, notMonitored: ['TETRA2000/zaim'], errors: [{ repo: 'TETRA2000/c', message: 'Bad Gateway (HTTP 502)' }], withOpenAlerts: 0 },
    };
    setup({}, overview);
    expect(await screen.findByText("1 repo isn't monitored: Dependabot alerts are turned off, so it has no data.")).toBeInTheDocument();
    expect(screen.getByText('TETRA2000/zaim')).toBeInTheDocument();
    expect(screen.getByText("1 repo couldn't be read in this Checkup:")).toBeInTheDocument();
    expect(screen.getByText('TETRA2000/c: Bad Gateway (HTTP 502)')).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Findings' })).not.toBeInTheDocument();
  });

  it('uses the plural sentences for several repos', async () => {
    const overview: Overview = {
      ...OVERVIEW,
      monitoring: { checked: 2, monitored: 0, notMonitored: ['a/x', 'a/y'], errors: [{ repo: 'a/p', message: 'm' }, { repo: 'a/q', message: 'n' }], withOpenAlerts: 0 },
    };
    setup({}, overview);
    expect(await screen.findByText("2 repos aren't monitored: Dependabot alerts are turned off, so they have no data.")).toBeInTheDocument();
    expect(screen.getByText("2 repos couldn't be read in this Checkup:")).toBeInTheDocument();
  });

  it('says when nothing matches', async () => {
    setup({ rows: [] });
    expect(await screen.findByText('No open alerts match these filters.')).toBeInTheDocument();
  });

  it('shows a load failure in an alert', async () => {
    const api = fakeApi({ listFindings: vi.fn(async () => { throw new Error("Error invoking remote method 'x': boom"); }) });
    render(<QueueView api={api} overview={OVERVIEW} snapshotId={7} repoFilter={null} onRepoFilterChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('filters by the repo it is given', async () => {
    const user = userEvent.setup();
    const overview: Overview = { ...OVERVIEW, repos: [{ id: 3, fullName: 'TETRA2000/c' }, { id: 4, fullName: 'TETRA2000/d' }], ecosystems: ['npm', 'pip'] };
    const { listFindings, onRepoFilterChange } = setup({ rows: [row(1)] }, overview, { repoFilter: 3 });
    await rows();
    expect(listFindings).toHaveBeenCalledWith({ snapshotId: 7, filter: { severities: ['critical'], repoId: 3, ecosystem: null } });
    const select = screen.getByRole('combobox', { name: 'Repo' });
    expect(select).toHaveValue('3');
    await user.selectOptions(select, 'TETRA2000/d');
    expect(onRepoFilterChange).toHaveBeenCalledWith(4);
    await user.selectOptions(select, 'All repos');
    expect(onRepoFilterChange).toHaveBeenLastCalledWith(null);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Ecosystem' }), 'pip');
    expect(listFindings).toHaveBeenLastCalledWith({ snapshotId: 7, filter: { severities: ['critical'], repoId: 3, ecosystem: 'pip' } });
  });

  it("clears a repo filter that isn't in the snapshot", async () => {
    const overview: Overview = { ...OVERVIEW, repos: [{ id: 3, fullName: 'TETRA2000/c' }] };
    const { onRepoFilterChange } = setup({ rows: [row(1)] }, overview, { repoFilter: 99 });
    await rows();
    expect(onRepoFilterChange).toHaveBeenCalledWith(null);
  });

  it('ignores a stale response that arrives after a newer one', async () => {
    const user = userEvent.setup();
    let resolveFirst!: (d: QueueData) => void;
    const first = new Promise<QueueData>((r) => { resolveFirst = r; });
    const listFindings = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ rows: [row(2)], counts: COUNTS });
    render(<QueueView api={fakeApi({ listFindings })} overview={OVERVIEW} snapshotId={7} repoFilter={null} onRepoFilterChange={vi.fn()} />);
    await user.click(screen.getByRole('checkbox', { name: 'High' }));
    expect(await screen.findByText(/pkg-2/)).toBeInTheDocument();
    const { act } = await import('@testing-library/react');
    await act(async () => resolveFirst({ rows: [row(1)], counts: COUNTS }));
    expect(screen.queryByText(/pkg-1/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('listbox', { name: 'Findings' })).getAllByRole('option')).toHaveLength(1);
  });

  it('moves the selection with the arrow keys', async () => {
    const user = userEvent.setup();
    const getFinding = vi.fn(async () => null);
    const listFindings = vi.fn(async () => ({ rows: [row(1), row(2), row(3)], counts: COUNTS }));
    render(<QueueView api={fakeApi({ listFindings, getFinding })} overview={OVERVIEW} snapshotId={7} repoFilter={null} onRepoFilterChange={vi.fn()} />);
    const items = await rows();
    const key = (n: number) => ({ snapshotId: 7, repoId: 1, number: n });
    const selected = () => items.map((r) => r.getAttribute('aria-selected'));

    await user.click(items[0]!);
    expect(getFinding).toHaveBeenLastCalledWith(key(1));
    await user.keyboard('{ArrowUp}');
    expect(selected()).toEqual(['true', 'false', 'false']);
    await user.keyboard('{ArrowDown}');
    expect(getFinding).toHaveBeenLastCalledWith(key(2));
    expect(selected()).toEqual(['false', 'true', 'false']);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(getFinding).toHaveBeenLastCalledWith(key(3));
    expect(selected()).toEqual(['false', 'false', 'true']);
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(selected()).toEqual(['true', 'false', 'false']);
  });
});
