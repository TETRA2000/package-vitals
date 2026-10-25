import { describe, it, expect } from 'vitest';
import { createCheckupController } from '../../../src/app/main/checkup.js';
import { runAccountCheckup } from '../../../src/core/checkup/account-checkup.js';
import { openDatabase } from '../../../src/core/db/database.js';
import type { CheckupSummary } from '../../../src/core/types.js';
import type { CheckupProgress } from '../../../src/app/shared/api.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';

const SUMMARY: CheckupSummary = {
  snapshotId: 1, reposChecked: 1, notMonitored: 0, errors: 0, open: { critical: 0, high: 0, medium: 0, low: 0 },
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('checkup controller', () => {
  it('runs one Checkup at a time', async () => {
    const d = deferred<CheckupSummary>();
    const c = createCheckupController({ run: () => d.promise, onProgress: () => {} });
    expect(c.running()).toBe(false);
    const first = c.start();
    expect(c.running()).toBe(true);
    expect(await c.start()).toEqual({ ok: false, message: 'A Checkup is already running.' });
    expect(c.running()).toBe(true);
    d.resolve(SUMMARY);
    expect(await first).toEqual({ ok: true, summary: SUMMARY });
    expect(c.running()).toBe(false);
  });

  it('turns a failure into its message', async () => {
    const c = createCheckupController({ run: async () => { throw new Error('Server Error (HTTP 500)'); }, onProgress: () => {} });
    expect(await c.start()).toEqual({ ok: false, message: 'Server Error (HTTP 500)' });
    expect(c.running()).toBe(false);
    // And it can run again.
    expect((await c.start()).ok).toBe(false);
  });

  it('never puts the token in a result', async () => {
    const db = openDatabase(':memory:');
    const c = createCheckupController({
      run: (onProgress) => runAccountCheckup({
        db, exec: async () => ({ stdout: 'gho_secret\n' }), now: () => new Date(),
        fetch: fakeFetch({ '/user': { status: 401, body: { message: 'Bad credentials' } } }), onProgress,
      }, { includeForks: false, includeArchived: false, concurrency: 8 }),
      onProgress: () => {},
    });
    const result = await c.start();
    expect(result).toEqual({ ok: false, message: 'Bad credentials (HTTP 401)' });
    expect(JSON.stringify(result)).not.toContain('gho_secret');
    db.close();
  });

  it('forwards progress', async () => {
    const seen: CheckupProgress[] = [];
    const c = createCheckupController({
      run: async (onProgress) => { onProgress({ done: 1, total: 2, repo: 'TETRA2000/a' }); return SUMMARY; },
      onProgress: (p) => seen.push(p),
    });
    await c.start();
    expect(seen).toEqual([{ done: 1, total: 2, repo: 'TETRA2000/a' }]);
  });
});
