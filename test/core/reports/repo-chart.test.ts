import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { buildRepoChartData, renderRepoChart } from '../../../src/core/reports/repo-chart.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
afterEach(() => db.close());

const SNAPSHOT_LINE = 'Snapshot 1, completed 2026-10-24 01:00 UTC.';

function chart(repo: Parameters<typeof seedSnapshot>[1]['repos'][number]) {
  db = openDatabase(':memory:');
  const id = seedSnapshot(db, { repos: [repo] });
  return renderRepoChart(buildRepoChartData(db, id, `TETRA2000/${repo.name}`)!);
}

describe('renderRepoChart', () => {
  it('renders vital signs, open alerts, and dismissed alerts', () => {
    const out = chart({ name: 'slack-deck', alerts: [
      { severity: 'critical', packageName: 'minimist', ghsaId: 'GHSA-aaaa-bbbb-cccc', summary: 'Prototype pollution',
        firstPatched: '0.2.4', createdAt: '2022-03-18T00:00:00Z' },
      { severity: 'medium', packageName: 'debug', scope: null, createdAt: '2024-01-01T00:00:00Z', ghsaId: 'GHSA-dddd' },
      { state: 'dismissed', packageName: 'lodash', ghsaId: 'GHSA-eeee', summary: 'ReDoS', dismissedReason: 'tolerable_risk',
        dismissedComment: 'Package Vitals: dev only' },
      { state: 'auto_dismissed', packageName: 'jest', ghsaId: 'GHSA-ffff', summary: 'Dev tool' },
      { state: 'fixed', packageName: 'fixed-pkg' },
    ] });
    expect(out).toBe(`# Repo chart: TETRA2000/slack-deck

${SNAPSHOT_LINE}

## Vital signs

| Critical | High | Medium | Low | Oldest open alert |
|---:|---:|---:|---:|---|
| 1 | 0 | 1 | 0 | 2022-03-18 |

## Open alerts

| Severity | Package | Ecosystem | Manifest | Scope | Advisory | Patched in |
|---|---|---|---|---|---|---|
| Critical | minimist | npm | package-lock.json | runtime | GHSA-aaaa-bbbb-cccc: Prototype pollution | 0.2.4 |
| Medium | debug | npm | package-lock.json | — | GHSA-dddd: Seeded advisory | No patched version |

## Dismissed alerts

| Package | Advisory | Reason | Comment |
|---|---|---|---|
| lodash | GHSA-eeee: ReDoS | tolerable_risk | Package Vitals: dev only |
| jest | GHSA-ffff: Dev tool | Auto-dismissed | — |
`);
  });

  // Review Focus 1
  it('escapes advisory text', () => {
    const out = chart({ name: 'a', alerts: [{ summary: 'Bad | thing\n<img src=x onerror=alert(1)>' }] });
    const row = out.split('\n').find((l) => l.includes('Bad'))!;
    expect(row).toContain('Bad \\| thing &lt;img src=x onerror=alert(1)&gt;');
    expect(row.startsWith('| High |')).toBe(true);
    expect(row.replace(/\\\|/g, '').split('|')).toHaveLength(9);
    expect(out).not.toContain('<img');
  });

  it('shows No open alerts. for a monitored repo with none', () => {
    const out = chart({ name: 'a', alerts: [{ state: 'fixed' }] });
    expect(out).toContain('## Open alerts\n\nNo open alerts.\n');
    expect(out).toContain('## Dismissed alerts\n\nNo dismissed alerts.\n');
    expect(out).toContain('| 0 | 0 | 0 | 0 | — |');
  });

  it('shows exactly the not-monitored sentence', () => {
    expect(chart({ name: 'b', alertsStatus: 'not_monitored' })).toBe(`# Repo chart: TETRA2000/b

${SNAPSHOT_LINE}

Dependabot alerts are turned off for this repo, so there is no data.
`);
  });

  it('shows the escaped error for a repo the Checkup could not read', () => {
    expect(chart({ name: 'c', alertsStatus: 'error', alertsError: 'Nope <b>|</b>' })).toBe(`# Repo chart: TETRA2000/c

${SNAPSHOT_LINE}

The Checkup couldn't read alerts for this repo: Nope &lt;b&gt;\\|&lt;/b&gt;
`);
  });
});

describe('buildRepoChartData', () => {
  it('returns null for a repo that is not in the snapshot', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'a' }] });
    expect(buildRepoChartData(db, id, 'TETRA2000/zzz')).toBeNull();
  });

  // Review Focus 3
  it('refuses a snapshot that is not complete', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { status: 'running', repos: [{ name: 'a' }] });
    expect(() => buildRepoChartData(db, id, 'TETRA2000/a')).toThrow(/not complete/);
  });
});
