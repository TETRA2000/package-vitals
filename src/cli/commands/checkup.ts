import { runCheckup } from '../../core/checkup/checkup.js';
import { openDatabase } from '../../core/db/database.js';
import { GitHubClient } from '../../core/github/client.js';
import { getAuthenticatedOwner } from '../../core/github/repos.js';
import { getGitHubToken } from '../../core/github/token.js';
import { dataPaths, resolveDataHome } from '../../core/paths.js';
import { formatCount, formatPlural } from '../../core/reports/markdown.js';
import type { CliDeps } from '../main.js';

export async function checkupCommand(
  opts: { includeForks: boolean; includeArchived: boolean; concurrency: number },
  deps: CliDeps,
): Promise<number> {
  const token = await getGitHubToken(deps.exec);
  const client = new GitHubClient({ token, fetch: deps.fetch });
  const owner = await getAuthenticatedOwner(client);
  const db = openDatabase(dataPaths(resolveDataHome(deps.env, deps.platform, deps.homeDir)).db);
  try {
    const s = await runCheckup(
      { db, client, now: deps.now, onProgress: (p) => deps.stderr(`[${p.done}/${p.total}] ${p.repo}`) },
      { owner, ...opts },
    );
    deps.stdout(`Checked ${formatPlural(s.reposChecked, 'repo')}: ${formatCount(s.open.critical)} critical, `
      + `${formatCount(s.open.high)} high, ${formatCount(s.open.medium)} medium, ${formatCount(s.open.low)} low open alerts. `
      + `${formatCount(s.notMonitored)} not monitored, ${formatCount(s.errors)} with errors. Snapshot ${s.snapshotId}.`);
    if (s.errors > 0) {
      deps.stderr(`Warning: alerts for ${formatPlural(s.errors, 'repo')} couldn't be read and aren't counted. `
        + 'Run the checkup again to retry.');
    }
    return 0;
  } finally {
    db.close();
  }
}
