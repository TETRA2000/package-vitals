import { openDatabase } from '../../core/db/database.js';
import { dataPaths, resolveDataHome } from '../../core/paths.js';
import { getSnapshot, latestCompleteSnapshot } from '../../core/queries/snapshots.js';
import { generateAccountReport, generateRepoChart } from '../../core/reports/generate.js';
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
      deps.stdout(generateAccountReport(db, paths.reports, s, createdAt).path);
      return 0;
    }
    const chart = generateRepoChart(db, paths.reports, s, opts.fullName, createdAt);
    if (chart === null) {
      deps.stderr(`Repo ${opts.fullName} is not in snapshot ${s.id}.`);
      return 1;
    }
    deps.stdout(chart.path);
    return 0;
  } finally {
    db.close();
  }
}
