import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

export type Db = DatabaseSync;

/**
 * Opens (creating if needed) the SQLite file and brings it to the current
 * schema. The app, CLI, and MCP server may all have it open at once, so it
 * uses WAL and waits up to 5 seconds for another process's write lock.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

function userVersion(db: Db): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function migrate(db: Db): void {
  if (userVersion(db) >= SCHEMA_VERSION) return;
  transaction(db, () => {
    // Re-read under the write lock: another process may have migrated meanwhile.
    for (let v = userVersion(db); v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}
