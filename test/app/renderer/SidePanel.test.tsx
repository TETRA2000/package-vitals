import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SidePanel } from '../../../src/app/renderer/components/SidePanel.js';
import type { FindingDetail, FindingKey } from '../../../src/core/types.js';
import { fakeApi } from './fake-api.js';

const key: FindingKey = { snapshotId: 7, repoId: 1, number: 42 };
const detail: FindingDetail = {
  ...key, fullName: 'TETRA2000/a', severity: 'critical', ecosystem: 'npm', packageName: 'minimist',
  ghsaId: 'GHSA-xvch-5gv4-984h', summary: 'Prototype Pollution in minimist', manifestPath: 'package-lock.json',
  createdAt: '2022-03-18T10:00:00Z', triage: 'not_triaged', cveId: 'CVE-2021-44906', scope: 'runtime',
  relationship: 'direct', vulnerableRange: '< 1.2.6', firstPatched: '1.2.6',
};
const NOW = '2026-10-24T05:07:09.000Z';

describe('SidePanel', () => {
  it('prompts when nothing is selected', () => {
    render(<SidePanel api={fakeApi()} findingKey={null} now={NOW} />);
    expect(screen.getByText('Select a finding to see its details.')).toBeInTheDocument();
  });

  it('shows the finding', async () => {
    render(<SidePanel api={fakeApi({ getFinding: vi.fn(async () => detail) })} findingKey={key} now={NOW} />);
    await screen.findByText('minimist');
    for (const text of ['npm', 'TETRA2000/a', 'Critical', 'GHSA-xvch-5gv4-984h', 'CVE-2021-44906',
      'Prototype Pollution in minimist', 'package-lock.json']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    const field = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(field('Patched in')).toHaveTextContent('1.2.6');
    expect(field('Vulnerable versions')).toHaveTextContent('< 1.2.6');
    expect(field('Scope')).toHaveTextContent('Runtime');
    expect(field('Open since')).toHaveTextContent('2022-03-18');
    expect(field('Triage')).toHaveTextContent('Not triaged');
  });

  it('shows No CVE and No patched version', async () => {
    const api = fakeApi({ getFinding: vi.fn(async () => ({ ...detail, cveId: null, firstPatched: null, scope: null, vulnerableRange: null })) });
    render(<SidePanel api={api} findingKey={key} now={NOW} />);
    await screen.findByText('minimist');
    expect(screen.getByText('No CVE')).toBeInTheDocument();
    expect(screen.getByText('No patched version')).toBeInTheDocument();
    expect(screen.getByText('Scope', { selector: 'dt' }).nextElementSibling).toHaveTextContent('—');
  });

  it('renders hostile text as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const api = fakeApi({ getFinding: vi.fn(async () => ({ ...detail, summary: hostile, packageName: hostile, manifestPath: hostile })) });
    const { container } = render(<SidePanel api={api} findingKey={key} now={NOW} />);
    await screen.findByText(hostile, { selector: 'p' });
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows a load failure in an alert', async () => {
    const api = fakeApi({ getFinding: vi.fn(async () => { throw new Error("Error invoking remote method 'getFinding': Error: boom"); }) });
    render(<SidePanel api={api} findingKey={key} now={NOW} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the finding: boom");
  });

  it('copies and opens through the API with the finding key', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ getFinding: vi.fn(async () => detail) });
    render(<SidePanel api={api} findingKey={key} now={NOW} />);
    await screen.findByText('minimist');
    await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    expect(api.copyFindingMarkdown).toHaveBeenCalledWith(key);
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open on GitHub' }));
    expect(api.openFindingOnGitHub).toHaveBeenCalledWith(key);
  });

  it('shows an action failure in an alert', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ getFinding: vi.fn(async () => detail), openFindingOnGitHub: vi.fn(async () => { throw new Error('nope'); }) });
    render(<SidePanel api={api} findingKey={key} now={NOW} />);
    await screen.findByText('minimist');
    await user.click(screen.getByRole('button', { name: 'Open on GitHub' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
