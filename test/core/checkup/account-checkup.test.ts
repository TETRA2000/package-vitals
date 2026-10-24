import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAccountCheckup } from '../../../src/core/checkup/account-checkup.js';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { fakeFetch, type FakeRoute } from '../../helpers/fake-fetch.js';
import { alertJson, repoJson } from '../../helpers/github-fixtures.js';

const ROUTES: Record<string, FakeRoute> = {
  '/user': { body: { login: 'TETRA2000' } },
  '/user/repos?affiliation=owner&per_page=100': { body: [repoJson('TETRA2000/a'), repoJson('TETRA2000/b')] },
  '/repos/TETRA2000/a/dependabot/alerts?per_page=100': { body: [alertJson({ number: 1, severity: 'critical' })] },
  '/repos/TETRA2000/b/dependabot/alerts?per_page=100': {
    status: 403, body: { message: 'Dependabot alerts are disabled for this repository.' } },
};
const OPTS = { includeForks: false, includeArchived: false, concurrency: 2 };

let db: Db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

describe('runAccountCheckup', () => {
  it('reads the token, finds the owner, and runs a Checkup', async () => {
    const fetch = fakeFetch(ROUTES);
    const progress: string[] = [];
    const s = await runAccountCheckup({
      db, fetch, exec: async () => ({ stdout: 'gho_test\n' }), now: () => new Date('2026-10-24T05:07:09.000Z'),
      onProgress: (p) => progress.push(`${p.done}/${p.total}`),
    }, OPTS);
    expect(s).toMatchObject({ snapshotId: 1, reposChecked: 2, notMonitored: 1, errors: 0, open: { critical: 1 } });
    expect(progress).toEqual(['1/2', '2/2']);
    expect(fetch.calls[0]!.headers.Authorization ?? fetch.calls[0]!.headers.authorization).toContain('gho_test');
  });

  it('reports a missing gh without creating a snapshot', async () => {
    const exec = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
    await expect(runAccountCheckup({ db, exec, fetch: fakeFetch(ROUTES), now: () => new Date() }, OPTS))
      .rejects.toThrow('GitHub CLI (gh) is not installed.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()).toEqual({ n: 0 });
  });
});
