import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { openDatabase, transaction, type Db } from '../../../src/core/db/database.js';
import { SCHEMA_VERSION } from '../../../src/core/db/schema.js';

const INSERT_SNAPSHOT = `INSERT INTO snapshots (owner_kind, owner_login, started_at, status)
  VALUES ('user', 'TETRA2000', '2026-10-24T00:00:00.000Z', 'running')`;

const open: Db[] = [];
const dirs: string[] = [];

function track(db: Db): Db {
  open.push(db);
  return db;
}

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pv-db-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'vitals.db');
}

function snapshotCount(db: Db): number {
  return (db.prepare('SELECT count(*) AS n FROM snapshots').get() as { n: number }).n;
}

afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('migrates a fresh database', () => {
    const db = track(openDatabase(':memory:'));
    expect(SCHEMA_VERSION).toBe(1);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['alerts', 'reports', 'repos', 'sbom_packages', 'snapshot_repos', 'snapshots']);
  });

  it('uses WAL for files and keeps data on reopen', () => {
    const file = tempFile();
    const first = track(openDatabase(file));
    first.prepare(INSERT_SNAPSHOT).run();
    first.close();

    const db = track(openDatabase(file));
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(snapshotCount(db)).toBe(1);
  });

  it('enforces foreign keys', () => {
    const db = track(openDatabase(':memory:'));
    expect(() => db.prepare(`INSERT INTO alerts (snapshot_id, repo_id, number, state, ecosystem, package_name,
      manifest_path, ghsa_id, severity, summary, created_at)
      VALUES (99, 1, 1, 'open', 'npm', 'minimist', 'package-lock.json', 'GHSA-x', 'high', 's', 'now')`).run()).toThrow();
  });
});

describe('transaction', () => {
  it('rolls back on throw', () => {
    const db = track(openDatabase(':memory:'));
    expect(() => transaction(db, () => {
      db.prepare(INSERT_SNAPSHOT).run();
      throw new Error('boom');
    })).toThrow('boom');
    expect(snapshotCount(db)).toBe(0);
  });

  it('returns the callback result after committing', () => {
    const db = track(openDatabase(':memory:'));
    expect(transaction(db, () => db.prepare(INSERT_SNAPSHOT).run().changes)).toBe(1);
    expect(snapshotCount(db)).toBe(1);
  });

  // Review Focus 5. node:sqlite is synchronous, so the writer that holds the lock
  // (connection A) lives in a worker thread with its own event loop, and our
  // connection (B) blocks the test thread while it waits for A to commit.
  it('a second connection waits for a writer instead of failing', async () => {
    const file = tempFile();
    track(openDatabase(file)).close();

    const writer = new Worker(`
      const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const a = new DatabaseSync(workerData.file);
      a.exec('BEGIN IMMEDIATE');
      a.prepare(workerData.insert).run();
      parentPort.postMessage('locked');
      setTimeout(() => { a.exec('COMMIT'); a.close(); parentPort.postMessage('committed'); }, 200);
    `, { eval: true, workerData: { file, insert: INSERT_SNAPSHOT } });
    const committed = new Promise((resolve) => writer.on('message', (m) => m === 'committed' && resolve(m)));
    await once(writer, 'message');

    const b = track(openDatabase(file));
    const started = Date.now();
    transaction(b, () => b.prepare(INSERT_SNAPSHOT).run());
    const waited = Date.now() - started;

    await committed;
    await writer.terminate();
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(snapshotCount(b)).toBe(2);
  });
});
