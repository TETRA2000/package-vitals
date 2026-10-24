import type { Db } from '../../../core/db/database.js';
import { getSnapshot, type SnapshotRow } from '../../../core/queries/snapshots.js';
import { IpcInputError } from '../validate.js';

/** Views read only complete snapshots, so a running, failed, or unknown one is refused. */
export function requireCompleteSnapshot(db: Db, id: number): SnapshotRow {
  const snapshot = getSnapshot(db, id);
  if (snapshot === null || snapshot.status !== 'complete') throw new IpcInputError(`Snapshot ${id} is not complete.`);
  return snapshot;
}
