import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { getSnapshot, latestCompleteSnapshot, previousCompleteSnapshot } from '../../../src/core/queries/snapshots.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
afterEach(() => db.close());

describe('snapshot lookup', () => {
  // Review Focus 3
  it('latestCompleteSnapshot ignores running and failed snapshots', () => {
    db = openDatabase(':memory:');
    seedSnapshot(db, { status: 'complete', repos: [] });
    seedSnapshot(db, { status: 'failed', repos: [] });
    seedSnapshot(db, { status: 'running', repos: [] });
    const latest = latestCompleteSnapshot(db);
    expect(latest).toEqual({ id: 1, ownerKind: 'user', ownerLogin: 'TETRA2000', startedAt: '2026-10-24T00:00:00.000Z',
      finishedAt: '2026-10-24T01:00:00.000Z', status: 'complete', includeForks: false, includeArchived: false });
    expect(previousCompleteSnapshot(db, latest!)).toBeNull();
  });

  it('returns null when there is no complete snapshot', () => {
    db = openDatabase(':memory:');
    seedSnapshot(db, { status: 'running', repos: [] });
    expect(latestCompleteSnapshot(db)).toBeNull();
  });

  it('previousCompleteSnapshot skips failed snapshots and other owners', () => {
    db = openDatabase(':memory:');
    seedSnapshot(db, { repos: [] });
    seedSnapshot(db, { owner: 'acme', repos: [] });
    seedSnapshot(db, { status: 'failed', repos: [] });
    seedSnapshot(db, { repos: [] });
    expect(previousCompleteSnapshot(db, getSnapshot(db, 4)!)?.id).toBe(1);
    expect(latestCompleteSnapshot(db, 'acme')?.id).toBe(2);
    expect(latestCompleteSnapshot(db, 'TETRA2000')?.id).toBe(4);
  });

  it('previousCompleteSnapshot only matches a snapshot with the same scope', () => {
    db = openDatabase(':memory:');
    seedSnapshot(db, { repos: [] });
    seedSnapshot(db, { includeArchived: true, repos: [] });
    seedSnapshot(db, { repos: [] });
    expect(getSnapshot(db, 2)).toMatchObject({ includeForks: false, includeArchived: true });
    expect(previousCompleteSnapshot(db, getSnapshot(db, 3)!)?.id).toBe(1);
    expect(previousCompleteSnapshot(db, getSnapshot(db, 2)!)).toBeNull();
  });

  it('getSnapshot returns any status, or null', () => {
    db = openDatabase(':memory:');
    seedSnapshot(db, { status: 'running', repos: [] });
    expect(getSnapshot(db, 1)).toMatchObject({ id: 1, status: 'running', finishedAt: null });
    expect(getSnapshot(db, 2)).toBeNull();
  });
});
