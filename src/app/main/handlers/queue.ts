import type { Db } from '../../../core/db/database.js';
import { criticalTreatmentPlan, monitoringSummary, repoCards } from '../../../core/queries/account.js';
import * as findings from '../../../core/queries/findings.js';
import { latestCompleteSnapshot } from '../../../core/queries/snapshots.js';
import type { Handlers } from '../../shared/api.js';
import { parseFindingKey, parseFindingsRequest, parseSnapshotId } from '../validate.js';
import { requireCompleteSnapshot } from './common.js';

/** The read-only handlers behind the queue, repo cards, and treatment plan. */
export function queueHandlers(
  deps: { db: Db; checkupRunning: () => boolean },
): Pick<Handlers, 'getOverview' | 'listFindings' | 'getFinding' | 'listRepoCards' | 'getTreatmentPlan'> {
  const { db } = deps;
  return {
    async getOverview() {
      const s = latestCompleteSnapshot(db);
      if (s === null) return { snapshot: null, monitoring: null, repos: [], ecosystems: [], checkupRunning: deps.checkupRunning() };
      return {
        snapshot: {
          id: s.id,
          ownerLogin: s.ownerLogin,
          finishedAt: s.finishedAt ?? s.startedAt,
          includeForks: s.includeForks,
          includeArchived: s.includeArchived,
        },
        monitoring: monitoringSummary(db, s.id),
        repos: findings.snapshotRepos(db, s.id),
        ecosystems: findings.findingEcosystems(db, s.id),
        checkupRunning: deps.checkupRunning(),
      };
    },

    async listFindings(arg) {
      const { snapshotId, filter } = parseFindingsRequest(arg);
      requireCompleteSnapshot(db, snapshotId);
      const { critical, matching } = findings.countFindings(db, snapshotId, filter);
      return {
        rows: findings.listFindings(db, snapshotId, filter),
        // Every finding is "Not triaged" until triage arrives, so that count is the matching rows.
        counts: { critical, notTriaged: matching, devOnly: null, reachable: null, uncertain: null },
      };
    },

    async getFinding(arg) {
      const key = parseFindingKey(arg);
      requireCompleteSnapshot(db, key.snapshotId);
      return findings.getFinding(db, key);
    },

    async listRepoCards(arg) {
      return repoCards(db, requireCompleteSnapshot(db, parseSnapshotId(arg)).id);
    },

    async getTreatmentPlan(arg) {
      return criticalTreatmentPlan(db, requireCompleteSnapshot(db, parseSnapshotId(arg)).id);
    },
  };
}
