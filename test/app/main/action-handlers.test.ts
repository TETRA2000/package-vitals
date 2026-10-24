import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionHandlers } from '../../../src/app/main/handlers/actions.js';
import { IpcInputError } from '../../../src/app/main/validate.js';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { getFinding } from '../../../src/core/queries/findings.js';
import { renderFindingMarkdown } from '../../../src/core/reports/finding-markdown.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

function setup() {
  const openExternal = vi.fn(async (_url: string) => undefined);
  const writeClipboard = vi.fn((_text: string) => undefined);
  return { openExternal, writeClipboard, handlers: actionHandlers({ db, openExternal, writeClipboard }) };
}
const repoId = (name: string) =>
  (db.prepare('SELECT id FROM repos WHERE full_name = ?').get(name) as { id: number }).id;

describe('action handlers', () => {
  it('openFindingOnGitHub opens the alert URL built from the database', async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a', alerts: [{}] }] });
    const { handlers, openExternal } = setup();
    await handlers.openFindingOnGitHub({ snapshotId, repoId: repoId('TETRA2000/a'), number: 1 });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/TETRA2000/a/security/dependabot/1');
  });

  it('rejects unknown, malformed, and not-complete keys without opening anything', async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a', alerts: [{}] }] });
    const running = seedSnapshot(db, { status: 'running', repos: [{ name: 'b', alerts: [{}] }] });
    const { handlers, openExternal, writeClipboard } = setup();
    const id = repoId('TETRA2000/a');
    const keys = [
      { snapshotId, repoId: id, number: 99 },
      { snapshotId, repoId: 999, number: 1 },
      { snapshotId: running, repoId: repoId('TETRA2000/b'), number: 2 },
      { snapshotId: 999, repoId: id, number: 1 },
      { snapshotId, repoId: id },
      'nope',
    ];
    for (const key of keys) {
      for (const call of [handlers.openFindingOnGitHub, handlers.copyFindingMarkdown]) {
        const err = await call(key).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(IpcInputError);
      }
    }
    const err = await handlers.openFindingOnGitHub(keys[0]).catch((e: unknown) => e);
    expect((err as Error).message).toBe('Finding not found.');
    expect(openExternal).not.toHaveBeenCalled();
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("refuses a repo name that isn't a GitHub name", async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a b', alerts: [{}] }] });
    const id = repoId('TETRA2000/a b');
    const { handlers, openExternal } = setup();
    const key = { snapshotId, repoId: id, number: 1 };
    expect(getFinding(db, key)).not.toBeNull();
    await expect(handlers.openFindingOnGitHub(key)).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('copyFindingMarkdown writes renderFindingMarkdown(getFinding) to the clipboard', async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a', alerts: [{ summary: 'x | y' }] }] });
    const key = { snapshotId, repoId: repoId('TETRA2000/a'), number: 1 };
    const { handlers, writeClipboard } = setup();
    await handlers.copyFindingMarkdown(key);
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith(renderFindingMarkdown(getFinding(db, key)!));
  });
});
