import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { openDatabase, transaction, type Db } from '../../../src/core/db/database.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../../../src/core/db/schema.js';

const INSERT_SNAPSHOT = `INSERT INTO snapshots (owner_kind, owner_login, include_forks, include_archived, started_at, status)
  VALUES ('user', 'TETRA2000', 0, 0, '2026-10-24T00:00:00.000Z', 'running')`;

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
    expect(SCHEMA_VERSION).toBe(2);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['alerts', 'direct_dependencies', 'findings', 'lockfiles', 'osv_advisories', 'reports', 'repos',
      'sbom_packages', 'snapshot_repos', 'snapshots']);
  });

  it('migration 2 adds Level 1 tables and turns open alerts into findings', () => {
    const file = tempFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const v1 = new DatabaseSync(file);
    v1.exec(MIGRATIONS[0]!);
    v1.exec('PRAGMA user_version = 1');
    v1.exec(INSERT_SNAPSHOT);
    v1.exec("INSERT INTO repos (full_name, is_private, is_fork, is_archived) VALUES ('TETRA2000/slack-deck', 0, 0, 0)");
    v1.exec("INSERT INTO snapshot_repos (snapshot_id, repo_id, alerts_status, sbom_status) VALUES (1, 1, 'ok', 'unavailable')");
    const insertAlert = v1.prepare(`INSERT INTO alerts (snapshot_id, repo_id, number, state, ecosystem, package_name,
      manifest_path, scope, relationship, ghsa_id, cve_id, severity, summary, vulnerable_range, first_patched, created_at)
      VALUES (1, 1, ?, ?, 'npm', 'minimist', 'package-lock.json', 'runtime', 'transitive', ?, 'CVE-2021-44906', 'critical',
      'Prototype Pollution in minimist', '< 0.2.4', '0.2.4', '2022-03-18T00:00:00Z')`);
    insertAlert.run(41, 'open', 'GHSA-xvch-5gv4-984h');
    insertAlert.run(42, 'dismissed', 'GHSA-vh95-rmgr-6w4m');
    v1.close();

    const db = track(openDatabase(file));
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(db.prepare('SELECT osv_status, osv_error FROM snapshots').get()).toEqual({ osv_status: null, osv_error: null });
    expect(db.prepare('SELECT lockfiles_status, lockfiles_error, tree_truncated FROM snapshot_repos').get())
      .toEqual({ lockfiles_status: null, lockfiles_error: null, tree_truncated: 0 });
    expect(db.prepare('SELECT * FROM findings').all()).toEqual([{
      id: 1, snapshot_id: 1, repo_id: 1, alert_number: 41, source: 'dependabot', ecosystem: 'npm', package_name: 'minimist',
      manifest_path: 'package-lock.json', advisory_id: 'GHSA-xvch-5gv4-984h', cve_id: 'CVE-2021-44906', severity: 'critical',
      severity_source: 'advisory', summary: 'Prototype Pollution in minimist', vulnerable_range: '< 0.2.4',
      first_patched: '0.2.4', created_at: '2022-03-18T00:00:00Z', scope: 'runtime', github_relationship: 'transitive',
      installed_versions: '[]', relationship: null, chains: '[]', chain_count: 0, lockfile_read: 0, lockfile_dev_only: null,
      js_bundler: null, tier: null, upgrades: null,
    }]);
  });

  it('uses WAL for files and keeps data on reopen', () => {
    const file = tempFile();
    const first = track(openDatabase(file));
    first.prepare(INSERT_SNAPSHOT).run();
    first.close();

    const db = track(openDatabase(file));
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
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
