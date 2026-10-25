import type { Db } from '../db/database.js';
import type { GitHubClient } from '../github/client.js';
import { listOwnerRepos } from '../github/repos.js';
import { fetchRepoAlerts } from '../github/alerts.js';
import { fetchRepoSbom } from '../github/sbom.js';
import { mapLimit } from '../concurrency.js';
import { createSnapshot, finishSnapshot, recordRepoResult, upsertRepo } from './store.js';
import type { AlertsResult, CheckupScope, CheckupSummary, Owner, SbomResult, SeverityCounts } from '../types.js';

export interface CheckupDeps {
  db: Db;
  client: GitHubClient;
  now: () => Date;
  onProgress?: (p: { done: number; total: number; repo: string }) => void;
}

export interface CheckupOptions extends CheckupScope {
  owner: Owner;
  concurrency: number;
}

/**
 * Runs a Level 0 Checkup into a new snapshot. A problem with one repo is
 * recorded for that repo and never fails the snapshot. Anything else marks
 * the snapshot `failed` and rethrows, so no snapshot is left `running`.
 */
export async function runCheckup(deps: CheckupDeps, opts: CheckupOptions): Promise<CheckupSummary> {
  const { db, client, now } = deps;
  const snapshotId = createSnapshot(db, opts.owner, now().toISOString(),
    { includeForks: opts.includeForks, includeArchived: opts.includeArchived });
  try {
    const repos = await listOwnerRepos(client, opts.owner, opts);
    const repoIds = repos.map((repo) => upsertRepo(db, repo));
    const summary: CheckupSummary = {
      snapshotId,
      reposChecked: repos.length,
      notMonitored: 0,
      errors: 0,
      open: { critical: 0, high: 0, medium: 0, low: 0 },
    };

    let done = 0;
    await mapLimit(repos, opts.concurrency, async (repo, index) => {
      // One request at a time per repo, so `concurrency` bounds requests in flight.
      const alerts = await fetchRepoAlerts(client, repo.fullName)
        .catch((err: unknown): AlertsResult => ({ status: 'error', message: messageOf(err) }));
      const sbom = await fetchRepoSbom(client, repo.fullName)
        .catch((err: unknown): SbomResult => ({ status: 'unavailable', message: messageOf(err) }));
      recordRepoResult(db, snapshotId, repoIds[index]!, alerts, sbom);

      if (alerts.status === 'not_monitored') summary.notMonitored++;
      if (alerts.status === 'error') summary.errors++;
      if (alerts.status === 'ok') {
        for (const a of alerts.alerts) if (a.state === 'open') summary.open[a.severity]++;
      }
      deps.onProgress?.({ done: ++done, total: repos.length, repo: repo.fullName });
    });

    finishSnapshot(db, snapshotId, 'complete', now().toISOString());
    return summary;
  } catch (err) {
    finishSnapshot(db, snapshotId, 'failed', now().toISOString(), messageOf(err));
    throw err;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
