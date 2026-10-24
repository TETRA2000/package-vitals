import type { Db } from '../db/database.js';
import {
  alertStateCounts, criticalTreatmentPlan, monitoringSummary, openAlertAges, openSeverityCounts, worstRepos,
  type AgeBucket, type AgeBucketRow, type MonitoringSummary, type StateCounts, type TreatmentRow, type WorstRepo,
} from '../queries/account.js';
import { getSnapshot, previousCompleteSnapshot } from '../queries/snapshots.js';
import type { SeverityCounts } from '../types.js';
import { escapeCell, formatChange, formatCount, formatDate, formatPlural, formatTimestamp } from './markdown.js';

export interface AccountReportData {
  ownerLogin: string;
  snapshotId: number;
  finishedAt: string;
  open: SeverityCounts;
  /** Current minus the previous complete snapshot, or null when there is none. */
  change: SeverityCounts | null;
  states: StateCounts;
  monitoring: MonitoringSummary;
  worst: WorstRepo[];
  treatment: TreatmentRow[];
  ages: AgeBucketRow[];
}

export const SEVERITY_LABELS: [keyof SeverityCounts, string][] = [
  ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'],
];

const AGE_LABELS: Record<AgeBucket, string> = {
  'under-30-days': 'Under 30 days',
  '30-90-days': '30–90 days',
  '90-365-days': '90–365 days',
  '1-2-years': '1–2 years',
  'over-2-years': 'Over 2 years',
};

/** Gathers every figure for the account report from one complete snapshot. */
export function buildAccountReportData(db: Db, snapshotId: number, now: Date): AccountReportData {
  const snapshot = getSnapshot(db, snapshotId);
  if (snapshot === null || snapshot.status !== 'complete') throw new Error(`Snapshot ${snapshotId} is not complete.`);
  const open = openSeverityCounts(db, snapshotId);
  const previous = previousCompleteSnapshot(db, snapshot);
  let change: SeverityCounts | null = null;
  if (previous !== null) {
    const before = openSeverityCounts(db, previous.id);
    change = { critical: open.critical - before.critical, high: open.high - before.high,
      medium: open.medium - before.medium, low: open.low - before.low };
  }
  return {
    ownerLogin: snapshot.ownerLogin,
    snapshotId,
    finishedAt: snapshot.finishedAt ?? snapshot.startedAt,
    open,
    change,
    states: alertStateCounts(db, snapshotId),
    monitoring: monitoringSummary(db, snapshotId),
    worst: worstRepos(db, snapshotId, 10),
    treatment: criticalTreatmentPlan(db, snapshotId, 10),
    ages: openAlertAges(db, snapshotId, now),
  };
}

export function renderAccountReport(d: AccountReportData): string {
  const m = d.monitoring;
  const out: string[] = [
    `# Account health report: ${escapeCell(d.ownerLogin)}`,
    '',
    `Snapshot ${d.snapshotId}, completed ${formatTimestamp(d.finishedAt)} UTC.`,
    '',
    '## Headline',
    '',
    `${formatCount(d.open.critical)} critical and ${formatCount(d.open.high)} high open alerts across `
      + `${formatPlural(m.withOpenAlerts, 'repo')}. Triage has not run yet, so these are Dependabot's raw counts.`,
    '',
    '## Open alerts by severity',
    '',
    '| Severity | Open | Change since previous snapshot |',
    '|---|---:|---:|',
    ...SEVERITY_LABELS.map(([key, label]) =>
      `| ${label} | ${formatCount(d.open[key])} | ${formatChange(d.change === null ? null : d.change[key])} |`),
    '',
    '## Alert states',
    '',
    '| Open | Dismissed | Auto-dismissed | Fixed |',
    '|---:|---:|---:|---:|',
    `| ${[d.states.open, d.states.dismissed, d.states.autoDismissed, d.states.fixed].map(formatCount).join(' | ')} |`,
    '',
    '## Repos',
    '',
    `${formatPlural(m.checked, 'repo')} checked: ${formatCount(m.monitored)} monitored, `
      + `${formatCount(m.notMonitored.length)} not monitored, ${formatCount(m.errors.length)} with errors.`,
    '',
    '### Not monitored',
    '',
    ...(m.notMonitored.length === 0
      ? ['None.']
      : ['Dependabot alerts are turned off for these repos, so they have no data:', '',
        ...m.notMonitored.map((repo) => `- \`${escapeCell(repo)}\``)]),
    '',
  ];

  if (m.errors.length > 0) {
    out.push('### Errors', '', ...m.errors.map((e) => `- \`${escapeCell(e.repo)}\`: ${escapeCell(e.message)}`), '');
  }

  out.push('## Worst repos', '');
  if (d.worst.length === 0) {
    out.push('No repos have open alerts.');
  } else {
    out.push('| Repo | Critical | High | Open | Oldest open alert |', '|---|---:|---:|---:|---|',
      ...d.worst.map((r) => `| ${escapeCell(r.fullName)} | ${formatCount(r.critical)} | ${formatCount(r.high)} | `
        + `${formatCount(r.open)} | ${formatDate(r.oldestOpenAlert)} |`));
  }

  out.push('', '## Treatment plan', '');
  if (d.treatment.length === 0) {
    out.push('No open critical alerts.');
  } else {
    out.push('Packages with an open critical alert, by how many repos they affect:', '',
      '| Package | Ecosystem | Repos | Patched in |', '|---|---|---:|---|',
      ...d.treatment.map((t) => `| ${escapeCell(t.packageName)} | ${escapeCell(t.ecosystem)} | ${formatCount(t.repoCount)} | `
        + `${t.patchedVersions.length === 0 ? 'No patched version' : t.patchedVersions.map(escapeCell).join(', ')} |`));
  }

  out.push('', '## How long alerts have been open', '', '| Age | All open | Critical |', '|---|---:|---:|',
    ...d.ages.map((a) => `| ${AGE_LABELS[a.bucket]} | ${formatCount(a.all)} | ${formatCount(a.critical)} |`), '');
  return out.join('\n');
}
