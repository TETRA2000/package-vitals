import type { Db } from '../db/database.js';
import { openSeverityCounts } from '../queries/account.js';
import { repoAlerts, type RepoAlertsView } from '../queries/repo.js';
import { getSnapshot } from '../queries/snapshots.js';
import type { SeverityCounts } from '../types.js';
import { SEVERITY_LABELS } from './account-report.js';
import { escapeCell, formatCount, formatDate, formatTimestamp } from './markdown.js';

export interface RepoChartData {
  snapshotId: number;
  finishedAt: string;
  view: RepoAlertsView;
  open: SeverityCounts;
  oldestOpenAlert: string | null;
}

/** The figures for one repo's chart, or null if the repo isn't in the (complete) snapshot. */
export function buildRepoChartData(db: Db, snapshotId: number, fullName: string): RepoChartData | null {
  const snapshot = getSnapshot(db, snapshotId);
  if (snapshot === null || snapshot.status !== 'complete') throw new Error(`Snapshot ${snapshotId} is not complete.`);
  const view = repoAlerts(db, snapshotId, fullName);
  if (view === null) return null;
  const oldest = view.open.reduce<string | null>(
    (min, a) => (min === null || Date.parse(a.createdAt) < Date.parse(min) ? a.createdAt : min), null);
  return {
    snapshotId,
    finishedAt: snapshot.finishedAt ?? snapshot.startedAt,
    view,
    open: openSeverityCounts(db, snapshotId, view.repoId),
    oldestOpenAlert: oldest,
  };
}

const SEVERITY_LABEL = Object.fromEntries(SEVERITY_LABELS) as Record<keyof SeverityCounts, string>;

export function renderRepoChart(d: RepoChartData): string {
  const { view } = d;
  const out: string[] = [
    `# Repo chart: ${escapeCell(view.fullName)}`,
    '',
    `Snapshot ${d.snapshotId}, completed ${formatTimestamp(d.finishedAt)} UTC.`,
    '',
  ];

  if (view.alertsStatus === 'not_monitored') {
    out.push('Dependabot alerts are turned off for this repo, so there is no data.', '');
    return out.join('\n');
  }
  if (view.alertsStatus === 'error') {
    out.push(`The Checkup couldn't read alerts for this repo: ${escapeCell(view.alertsError ?? '')}`, '');
    return out.join('\n');
  }

  const cell = (text: string | null) => (text === null ? '—' : escapeCell(text));
  out.push('## Vital signs', '', '| Critical | High | Medium | Low | Oldest open alert |', '|---:|---:|---:|---:|---|',
    `| ${formatCount(d.open.critical)} | ${formatCount(d.open.high)} | ${formatCount(d.open.medium)} | `
      + `${formatCount(d.open.low)} | ${formatDate(d.oldestOpenAlert)} |`,
    '', '## Open alerts', '');
  if (view.open.length === 0) {
    out.push('No open alerts.');
  } else {
    out.push('| Severity | Package | Ecosystem | Manifest | Scope | Advisory | Patched in |', '|---|---|---|---|---|---|---|',
      ...view.open.map((a) => `| ${SEVERITY_LABEL[a.severity]} | ${cell(a.packageName)} | ${cell(a.ecosystem)} | `
        + `${cell(a.manifestPath)} | ${cell(a.scope)} | ${cell(`${a.ghsaId}: ${a.summary}`)} | `
        + `${a.firstPatched === null ? 'No patched version' : cell(a.firstPatched)} |`));
  }

  out.push('', '## Dismissed alerts', '');
  if (view.dismissed.length === 0) {
    out.push('No dismissed alerts.');
  } else {
    out.push('| Package | Advisory | Reason | Comment |', '|---|---|---|---|',
      ...view.dismissed.map((a) => `| ${cell(a.packageName)} | ${cell(`${a.ghsaId}: ${a.summary}`)} | `
        + `${a.dismissedReason === null && a.state === 'auto_dismissed' ? 'Auto-dismissed' : cell(a.dismissedReason)} | `
        + `${cell(a.dismissedComment)} |`));
  }
  out.push('');
  return out.join('\n');
}
