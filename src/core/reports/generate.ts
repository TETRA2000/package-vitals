import type { Db } from '../db/database.js';
import type { SnapshotRow } from '../queries/snapshots.js';
import { buildAccountReportData, renderAccountReport } from './account-report.js';
import { buildRepoChartData, renderRepoChart } from './repo-chart.js';
import { accountReportFileName, repoChartFileName, writeReport } from './write.js';

/** Writes and records the account report for a snapshot. Alert ages are measured at the snapshot, so it is reproducible. */
export function generateAccountReport(
  db: Db, reportsDir: string, s: SnapshotRow, createdAt: string,
): { id: number; path: string } {
  const content = renderAccountReport(buildAccountReportData(db, s.id, new Date(s.finishedAt ?? s.startedAt)));
  return writeReport(db, reportsDir,
    { kind: 'account', snapshotId: s.id, repoId: null, fileName: accountReportFileName(s), content, createdAt });
}

/** Writes and records one repo's chart, or returns null when the repo is not in the snapshot. */
export function generateRepoChart(
  db: Db, reportsDir: string, s: SnapshotRow, fullName: string, createdAt: string,
): { id: number; path: string } | null {
  const data = buildRepoChartData(db, s.id, fullName);
  if (data === null) return null;
  return writeReport(db, reportsDir, { kind: 'repo', snapshotId: s.id, repoId: data.view.repoId,
    fileName: repoChartFileName(s, data.view.fullName), content: renderRepoChart(data), createdAt });
}
