import type { Db } from '../../src/core/db/database.js';
import { createSnapshot, finishSnapshot, recordRepoResult, upsertRepo } from '../../src/core/checkup/store.js';
import type { AlertsResult, DependabotAlert } from '../../src/core/types.js';

export interface SeedRepo {
  /** The repo name without its owner. */
  name: string;
  alertsStatus?: 'ok' | 'not_monitored' | 'error';
  /** The message for an `error` repo. Defaults to `Not Found (HTTP 404)`. */
  alertsError?: string;
  alerts?: Partial<DependabotAlert>[];
}

export interface SeedSpec {
  owner?: string;
  status?: 'running' | 'complete' | 'failed';
  finishedAt?: string;
  repos: SeedRepo[];
}

/** Seeds one snapshot through the store functions and returns its id. */
export function seedSnapshot(db: Db, spec: SeedSpec): number {
  const owner = spec.owner ?? 'TETRA2000';
  const snapshotId = createSnapshot(db, { kind: 'user', login: owner }, '2026-10-24T00:00:00.000Z');
  let number = 0;
  for (const repo of spec.repos) {
    const repoId = upsertRepo(db, { fullName: `${owner}/${repo.name}`, isPrivate: false, isFork: false,
      isArchived: false, defaultBranch: 'main', pushedAt: null });
    const status = repo.alertsStatus ?? 'ok';
    const alerts: AlertsResult =
      status === 'ok' ? { status, alerts: (repo.alerts ?? []).map((a) => ({ ...alertDefaults(++number), ...a })) }
      : status === 'error' ? { status, message: repo.alertsError ?? 'Not Found (HTTP 404)' }
      : { status };
    recordRepoResult(db, snapshotId, repoId, alerts, { status: 'unavailable', message: 'Not Found (HTTP 404)' });
  }
  const status = spec.status ?? 'complete';
  if (status !== 'running') finishSnapshot(db, snapshotId, status, spec.finishedAt ?? '2026-10-24T01:00:00.000Z');
  return snapshotId;
}

function alertDefaults(number: number): DependabotAlert {
  return {
    number,
    state: 'open',
    ecosystem: 'npm',
    packageName: 'pkg',
    manifestPath: 'package-lock.json',
    scope: 'runtime',
    relationship: 'direct',
    ghsaId: `GHSA-seed-${number}`,
    cveId: null,
    severity: 'high',
    summary: 'Seeded advisory',
    vulnerableRange: null,
    firstPatched: null,
    createdAt: '2026-01-01T00:00:00Z',
    dismissedAt: null,
    dismissedReason: null,
    dismissedComment: null,
    fixedAt: null,
  };
}
