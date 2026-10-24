import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TreatmentPlanView } from '../../../src/app/renderer/views/TreatmentPlanView.js';
import type { TreatmentRow } from '../../../src/core/types.js';
import { fakeApi, OVERVIEW } from './fake-api.js';

function setup(rows: TreatmentRow[]) {
  const getTreatmentPlan = vi.fn(async () => rows);
  render(<TreatmentPlanView api={fakeApi({ getTreatmentPlan })} overview={OVERVIEW} snapshotId={7} />);
  return { getTreatmentPlan };
}

describe('TreatmentPlanView', () => {
  it('shows the intro and a table of packages', async () => {
    const { getTreatmentPlan } = setup([
      { ecosystem: 'npm', packageName: 'lodash', repoCount: 3, patchedVersions: ['4.17.21', '5.0.0'] },
      { ecosystem: 'pip', packageName: 'django', repoCount: 1, patchedVersions: [] },
    ]);
    expect(await screen.findByText('lodash')).toBeInTheDocument();
    expect(getTreatmentPlan).toHaveBeenCalledWith(7);
    expect(screen.getByText('Packages with an open critical alert, by how many repos an upgrade would clear.')).toBeInTheDocument();
    for (const name of ['Package', 'Ecosystem', 'Repos', 'Patched in']) expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('lodashnpm34.17.21, 5.0.0');
    expect(rows[2]).toHaveTextContent('djangopip1No patched version');
  });

  it('shows an empty message when there are no rows', async () => {
    setup([]);
    expect(await screen.findByText('No open critical alerts.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders package text as text', async () => {
    setup([{ ecosystem: 'npm', packageName: '<img src=x>', repoCount: 1, patchedVersions: ['1.0.0'] }]);
    expect(await screen.findByText('<img src=x>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows a load failure in an alert', async () => {
    const getTreatmentPlan = vi.fn(async () => {
      throw new Error('nope');
    });
    render(<TreatmentPlanView api={fakeApi({ getTreatmentPlan })} overview={OVERVIEW} snapshotId={7} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the treatment plan: nope");
  });
});
