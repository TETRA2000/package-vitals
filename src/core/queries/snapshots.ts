import type { Db } from '../db/database.js';

export interface SnapshotRow {
  id: number;
  ownerKind: 'user' | 'org';
  ownerLogin: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'complete' | 'failed';
}

const SELECT = `SELECT id, owner_kind AS ownerKind, owner_login AS ownerLogin, started_at AS startedAt,
  finished_at AS finishedAt, status FROM snapshots`;

function row(r: unknown): SnapshotRow | null {
  return r === undefined ? null : { ...(r as SnapshotRow) };
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

/** The complete snapshot for the same owner that came before `s`. */
export function previousCompleteSnapshot(db: Db, s: SnapshotRow): SnapshotRow | null {
  return row(db.prepare(`${SELECT} WHERE status = 'complete' AND owner_login = ? AND id < ? ORDER BY id DESC LIMIT 1`)
    .get(s.ownerLogin, s.id));
}
