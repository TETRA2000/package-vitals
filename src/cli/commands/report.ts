import { openDatabase } from '../../core/db/database.js';
import { dataPaths, resolveDataHome } from '../../core/paths.js';
import { getSnapshot, latestCompleteSnapshot } from '../../core/queries/snapshots.js';
import { buildAccountReportData, renderAccountReport } from '../../core/reports/account-report.js';
import { buildRepoChartData, renderRepoChart } from '../../core/reports/repo-chart.js';
import { accountReportFileName, repoChartFileName, writeReport } from '../../core/reports/write.js';
import type { CliDeps } from '../main.js';

const NO_CHECKUP = 'No completed checkup yet. Run `package-vitals checkup` first.';

export async function reportCommand(
  opts: { kind: 'account'; snapshot?: number } | { kind: 'repo'; fullName: string; snapshot?: number },
  deps: CliDeps,
): Promise<number> {
  const paths = dataPaths(resolveDataHome(deps.env, deps.platform, deps.homeDir));
  const db = openDatabase(paths.db);
  try {
    const s = opts.snapshot === undefined ? latestCompleteSnapshot(db) : getSnapshot(db, opts.snapshot);
    if (s === null || s.status !== 'complete') {
      deps.stderr(NO_CHECKUP);
      return 1;
    }
    const createdAt = deps.now().toISOString();
    if (opts.kind === 'account') {
      // Alert ages are measured at the snapshot, so a report is reproducible from the database.
      const content = renderAccountReport(buildAccountReportData(db, s.id, new Date(s.finishedAt ?? s.startedAt)));
      deps.stdout(writeReport(db, paths.reports,
        { kind: 'account', snapshotId: s.id, repoId: null, fileName: accountReportFileName(s), content, createdAt }));
      return 0;
    }
    const data = buildRepoChartData(db, s.id, opts.fullName);
    if (data === null) {
      deps.stderr(`Repo ${opts.fullName} is not in snapshot ${s.id}.`);
      return 1;
    }
    deps.stdout(writeReport(db, paths.reports, { kind: 'repo', snapshotId: s.id, repoId: data.view.repoId,
      fileName: repoChartFileName(s, data.view.fullName), content: renderRepoChart(data), createdAt }));
    return 0;
  } finally {
    db.close();
  }
}
