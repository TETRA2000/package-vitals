import { describe, it, expect } from 'vitest';
import { GitHubClient } from '../../../src/core/github/client.js';
import { getAuthenticatedOwner, listOwnerRepos } from '../../../src/core/github/repos.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { repoJson } from '../../helpers/github-fixtures.js';

const USER_REPOS = '/user/repos?affiliation=owner&per_page=100';
const NONE = { includeForks: false, includeArchived: false };

const client = (f: ReturnType<typeof fakeFetch>) => new GitHubClient({ token: 't', fetch: f });

const mixed = [
  repoJson('TETRA2000/b'),
  repoJson('TETRA2000/a', { fork: true }),
  repoJson('TETRA2000/c', { archived: true }),
  repoJson('TETRA2000/d'),
];

describe('getAuthenticatedOwner', () => {
  it('returns the authenticated user', async () => {
    const f = fakeFetch({ '/user': { body: { login: 'TETRA2000', id: 1 } } });
    expect(await getAuthenticatedOwner(client(f))).toEqual({ kind: 'user', login: 'TETRA2000' });
  });
});

describe('listOwnerRepos', () => {
  it('lists the user’s own repos', async () => {
    const f = fakeFetch({ [USER_REPOS]: { body: [] } });
    await listOwnerRepos(client(f), { kind: 'user', login: 'TETRA2000' }, NONE);
    expect(f.calls.map((c) => c.url)).toEqual([`https://api.github.com${USER_REPOS}`]);
  });

  it('lists an org’s repos', async () => {
    const f = fakeFetch({ '/orgs/acme/repos?type=all&per_page=100': { body: [] } });
    await listOwnerRepos(client(f), { kind: 'org', login: 'acme' }, NONE);
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.github.com/orgs/acme/repos?type=all&per_page=100']);
  });

  it('skips forks and archived repos by default, sorted by name', async () => {
    const repos = await listOwnerRepos(client(fakeFetch({ [USER_REPOS]: { body: mixed } })), { kind: 'user', login: 'TETRA2000' }, NONE);
    expect(repos.map((r) => r.fullName)).toEqual(['TETRA2000/b', 'TETRA2000/d']);
  });

  it('includes forks and archived repos when asked', async () => {
    const repos = await listOwnerRepos(client(fakeFetch({ [USER_REPOS]: { body: mixed } })), { kind: 'user', login: 'TETRA2000' },
      { includeForks: true, includeArchived: true });
    expect(repos.map((r) => r.fullName)).toEqual(['TETRA2000/a', 'TETRA2000/b', 'TETRA2000/c', 'TETRA2000/d']);
  });

  it('maps API fields', async () => {
    const f = fakeFetch({ [USER_REPOS]: { body: [
      repoJson('TETRA2000/x', { private: true, fork: true, archived: true, pushed_at: '2026-09-09T09:09:09Z' }),
      { ...repoJson('TETRA2000/empty'), default_branch: null, pushed_at: null },
    ] } });
    const repos = await listOwnerRepos(client(f), { kind: 'user', login: 'TETRA2000' }, { includeForks: true, includeArchived: true });
    expect(repos).toEqual([
      { fullName: 'TETRA2000/empty', isPrivate: false, isFork: false, isArchived: false, defaultBranch: null, pushedAt: null },
      { fullName: 'TETRA2000/x', isPrivate: true, isFork: true, isArchived: true, defaultBranch: 'main', pushedAt: '2026-09-09T09:09:09Z' },
    ]);
  });
});
