import type { Db } from '../db/database.js';
import type { CheckupScope } from '../types.js';

export interface SnapshotRow extends CheckupScope {
  id: number;
  ownerKind: 'user' | 'org';
  ownerLogin: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'complete' | 'failed';
}

const SELECT = `SELECT id, owner_kind AS ownerKind, owner_login AS ownerLogin, started_at AS startedAt,
  finished_at AS finishedAt, status, include_forks AS includeForks, include_archived AS includeArchived FROM snapshots`;

function row(r: unknown): SnapshotRow | null {
  if (r === undefined) return null;
  const s = r as Omit<SnapshotRow, keyof CheckupScope> & { includeForks: number; includeArchived: number };
  return { ...s, includeForks: s.includeForks === 1, includeArchived: s.includeArchived === 1 };
}

export function getSnapshot(db: Db, id: number): SnapshotRow | null {
  return row(db.prepare(`${SELECT} WHERE id = ?`).get(id));
}

/** The latest snapshot whose Checkup finished. Running and failed snapshots never feed reports. */
export function latestCompleteSnapshot(db: Db, ownerLogin?: string): SnapshotRow | null {
  return ownerLogin === undefined
    ? row(db.prepare(`${SELECT} WHERE status = 'complete' ORDER BY id DESC LIMIT 1`).get())
    : row(db.prepare(`${SELECT} WHERE status = 'complete' AND owner_login = ? ORDER BY id DESC LIMIT 1`).get(ownerLogin));
}

/** The complete snapshot for the same owner and scope that came before `s`. */
export function previousCompleteSnapshot(db: Db, s: SnapshotRow): SnapshotRow | null {
  return row(db.prepare(`${SELECT} WHERE status = 'complete' AND owner_login = ? AND include_forks = ?
    AND include_archived = ? AND id < ? ORDER BY id DESC LIMIT 1`)
    .get(s.ownerLogin, Number(s.includeForks), Number(s.includeArchived), s.id));
}
