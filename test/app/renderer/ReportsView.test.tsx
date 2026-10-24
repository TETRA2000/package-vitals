import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReportsView } from '../../../src/app/renderer/views/ReportsView.js';
import type { ReportEntry } from '../../../src/core/types.js';
import { fakeApi, OVERVIEW } from './fake-api.js';

const account: ReportEntry = { id: 2, kind: 'account', snapshotId: 7, repoFullName: null, fileName: 'a.md', createdAt: '2026-10-24T05:00:00.000Z' };
const chart: ReportEntry = { id: 1, kind: 'repo', snapshotId: 7, repoFullName: 'TETRA2000/a', fileName: 'b.md', createdAt: '2026-10-23T05:00:00.000Z' };
const overview = { ...OVERVIEW, repos: [{ id: 3, fullName: 'TETRA2000/a' }] };

describe('ReportsView', () => {
  it('lists reports newest first and renders the selected one', async () => {
    const readReport = vi.fn(async (id: number) => (id === 2 ? '# Account heading' : '# Chart heading'));
    render(<ReportsView api={fakeApi({ listReports: vi.fn(async () => [account, chart]), readReport })} overview={overview} snapshotId={7} />);
    const items = await screen.findAllByRole('button', { name: /snapshot 7/ });
    expect(items[0]).toHaveTextContent('Account report · snapshot 7 · 2026-10-24 05:00 UTC');
    expect(items[1]).toHaveTextContent('Repo chart: TETRA2000/a · snapshot 7 ·');
    await userEvent.click(items[1]!);
    expect(await screen.findByRole('heading', { name: 'Chart heading' })).toBeInTheDocument();
    expect(readReport).toHaveBeenCalledWith(1);
  });

  it('generates an account report and selects it', async () => {
    let list: ReportEntry[] = [chart];
    const generateReport = vi.fn(async () => { list = [account, chart]; return account; });
    const readReport = vi.fn(async () => '# Fresh');
    render(<ReportsView api={fakeApi({ listReports: vi.fn(async () => list), generateReport, readReport })} overview={overview} snapshotId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate account report' }));
    expect(generateReport).toHaveBeenCalledWith({ kind: 'account', snapshotId: 7 });
    expect(await screen.findByRole('heading', { name: 'Fresh' })).toBeInTheDocument();
    expect(readReport).toHaveBeenCalledWith(2);
    expect(screen.getAllByRole('button', { name: /snapshot 7/ })).toHaveLength(2);
  });

  it('generates a repo chart for the chosen repo', async () => {
    const generateReport = vi.fn(async () => chart);
    render(<ReportsView api={fakeApi({ generateReport })} overview={overview} snapshotId={7} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Repo' }), 'TETRA2000/a');
    await userEvent.click(screen.getByRole('button', { name: 'Generate repo chart' }));
    expect(generateReport).toHaveBeenCalledWith({ kind: 'repo', snapshotId: 7, repoId: 3 });
  });

  it('shows a read error', async () => {
    const readReport = vi.fn(async () => { throw new Error("Error invoking remote method 'vitals:readReport': IpcInputError: Report file is missing."); });
    render(<ReportsView api={fakeApi({ listReports: vi.fn(async () => [account]), readReport })} overview={overview} snapshotId={7} />);
    await userEvent.click(await screen.findByRole('button', { name: /snapshot 7/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Report file is missing.');
  });
});
