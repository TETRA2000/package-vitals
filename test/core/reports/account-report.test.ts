import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { buildAccountReportData, renderAccountReport, type AccountReportData }
  from '../../../src/core/reports/account-report.js';
import { seedSnapshot } from '../../helpers/seed.js';

const DATA: AccountReportData = {
  ownerLogin: 'TETRA2000',
  snapshotId: 7,
  finishedAt: '2026-10-24T05:07:09.000Z',
  open: { critical: 522, high: 4439, medium: 4018, low: 1028 },
  change: null,
  states: { open: 10007, dismissed: 12, autoDismissed: 3, fixed: 2500 },
  monitoring: { checked: 355, monitored: 355, notMonitored: [], errors: [], withOpenAlerts: 126 },
  worst: [{ fullName: 'TETRA2000/slack-deck', critical: 9, high: 20, open: 50, oldestOpenAlert: '2022-03-18T00:00:00Z' }],
  treatment: [
    { ecosystem: 'npm', packageName: 'form-data', repoCount: 23, patchedVersions: ['2.5.4', '4.0.4'] },
    { ecosystem: 'npm', packageName: 'mystery', repoCount: 1, patchedVersions: [] },
  ],
  ages: [
    { bucket: 'under-30-days', all: 100, critical: 1 },
    { bucket: '30-90-days', all: 200, critical: 2 },
    { bucket: '90-365-days', all: 300, critical: 3 },
    { bucket: '1-2-years', all: 400, critical: 4 },
    { bucket: 'over-2-years', all: 9007, critical: 512 },
  ],
};

const GOLDEN = `# Account health report: TETRA2000

Snapshot 7, completed 2026-10-24 05:07 UTC.

## Headline

522 critical and 4,439 high open alerts across 126 repos. Triage has not run yet, so these are Dependabot's raw counts.

## Open alerts by severity

| Severity | Open | Change since previous snapshot |
|---|---:|---:|
| Critical | 522 | n/a |
| High | 4,439 | n/a |
| Medium | 4,018 | n/a |
| Low | 1,028 | n/a |

## Alert states

| Open | Dismissed | Auto-dismissed | Fixed |
|---:|---:|---:|---:|
| 10,007 | 12 | 3 | 2,500 |

## Repos

355 repos checked: 355 monitored, 0 not monitored, 0 with errors.

### Not monitored

None.

## Worst repos

| Repo | Critical | High | Open | Oldest open alert |
|---|---:|---:|---:|---|
| TETRA2000/slack-deck | 9 | 20 | 50 | 2022-03-18 |

## Treatment plan

Packages with an open critical alert, by how many repos they affect:

| Package | Ecosystem | Repos | Patched in |
|---|---|---:|---|
| form-data | npm | 23 | 2.5.4, 4.0.4 |
| mystery | npm | 1 | No patched version |

## How long alerts have been open

| Age | All open | Critical |
|---|---:|---:|
| Under 30 days | 100 | 1 |
| 30–90 days | 200 | 2 |
| 90–365 days | 300 | 3 |
| 1–2 years | 400 | 4 |
| Over 2 years | 9,007 | 512 |
`;

describe('renderAccountReport', () => {
  it('renders the exact report structure', () => {
    expect(renderAccountReport(DATA)).toBe(GOLDEN);
  });

  it('states the headline, raw counts, and empty sections', () => {
    const out = renderAccountReport(DATA);
    expect(out).toContain('522 critical and 4,439 high open alerts across 126 repos.');
    expect(out).toContain('| Critical | 522 | n/a |');
    expect(out).toContain('## Not monitored\n\nNone.');
    expect(out).not.toContain('### Errors');
    // Review Focus 4
    expect(out).toContain('| mystery | npm | 1 | No patched version |');
    expect(out).not.toContain('null');
  });

  it('lists not monitored repos and errors, with escaped messages', () => {
    const out = renderAccountReport({ ...DATA, monitoring: { checked: 3, monitored: 1, notMonitored: ['TETRA2000/b'],
      errors: [{ repo: 'TETRA2000/c', message: 'Bad <b>gateway</b>\nretry | later' }], withOpenAlerts: 1 } });
    expect(out).toContain('3 repos checked: 1 monitored, 1 not monitored, 1 with errors.');
    expect(out).toContain('### Not monitored\n\nDependabot alerts are turned off for these repos, so they have no data:\n\n- `TETRA2000/b`\n');
    expect(out).toContain('### Errors\n\n- `TETRA2000/c`: Bad &lt;b&gt;gateway&lt;/b&gt; retry \\| later\n');
    expect(out).not.toContain('<b>');
  });

  it('keeps underscores in not monitored and error repo names literal', () => {
    const out = renderAccountReport({ ...DATA, monitoring: { checked: 2, monitored: 0, notMonitored: ['TETRA2000/_private_'],
      errors: [{ repo: 'TETRA2000/__init__', message: 'Not Found (HTTP 404)' }], withOpenAlerts: 0 } });
    expect(out).toContain('- `TETRA2000/_private_`\n');
    expect(out).toContain('- `TETRA2000/__init__`: Not Found (HTTP 404)\n');
  });

  it('shows changes and says when there is nothing to list', () => {
    const out = renderAccountReport({ ...DATA, change: { critical: 3, high: -2, medium: 0, low: 1 }, worst: [], treatment: [] });
    expect(out).toContain('| Critical | 522 | +3 |\n| High | 4,439 | -2 |\n| Medium | 4,018 | 0 |\n| Low | 1,028 | +1 |');
    expect(out).toContain('## Worst repos\n\nNo repos have open alerts.\n');
    expect(out).toContain('## Treatment plan\n\nNo open critical alerts.\n');
  });

  it('escapes repo-derived text in tables', () => {
    const out = renderAccountReport({ ...DATA, treatment: [
      { ecosystem: 'np|m', packageName: '<script>x</script>', repoCount: 1, patchedVersions: ['1.0.0|evil'] }] });
    expect(out).toContain('| &lt;script&gt;x&lt;/script&gt; | np\\|m | 1 | 1.0.0\\|evil |');
  });
});

describe('buildAccountReportData', () => {
  let db: Db;
  afterEach(() => db.close());

  it('computes the change since the previous complete snapshot', () => {
    db = openDatabase(':memory:');
    const crit = (n: number) => Array.from({ length: n }, () => ({ severity: 'critical' as const }));
    seedSnapshot(db, { repos: [{ name: 'a', alerts: crit(2) }] });
    seedSnapshot(db, { status: 'failed', repos: [{ name: 'a', alerts: crit(9) }] });
    const id = seedSnapshot(db, { finishedAt: '2026-10-24T05:07:09.000Z', repos: [{ name: 'a', alerts: crit(5) }, { name: 'b', alertsStatus: 'not_monitored' }] });
    const data = buildAccountReportData(db, id, new Date('2026-10-24T06:00:00Z'));
    expect(data.change?.critical).toBe(3);
    expect(data).toMatchObject({ ownerLogin: 'TETRA2000', snapshotId: 3, finishedAt: '2026-10-24T05:07:09.000Z',
      monitoring: { checked: 2, notMonitored: ['TETRA2000/b'] } });
    expect(data.ages).toHaveLength(5);
    expect(renderAccountReport(data)).toContain('| Critical | 5 | +3 |');
  });

  it('has no change for the first snapshot', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'a', alerts: [{ severity: 'critical' }] }] });
    expect(buildAccountReportData(db, id, new Date()).change).toBeNull();
  });

  // Review Focus 3
  it('refuses a snapshot that is not complete', () => {
    db = openDatabase(':memory:');
    const running = seedSnapshot(db, { status: 'running', repos: [] });
    const failed = seedSnapshot(db, { status: 'failed', repos: [] });
    expect(() => buildAccountReportData(db, running, new Date())).toThrow(/not complete/);
    expect(() => buildAccountReportData(db, failed, new Date())).toThrow(/not complete/);
    expect(() => buildAccountReportData(db, 99, new Date())).toThrow(/not complete/);
  });
});
