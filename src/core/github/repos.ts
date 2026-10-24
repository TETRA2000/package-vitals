import type { GitHubClient } from './client.js';
import type { Owner, RepoInfo } from '../types.js';

interface RepoJson {
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string | null;
  pushed_at: string | null;
}

export async function getAuthenticatedOwner(client: GitHubClient): Promise<Owner> {
  const user = await client.getJson<{ login: string }>('/user');
  return { kind: 'user', login: user.login };
}

export async function listOwnerRepos(
  client: GitHubClient,
  owner: Owner,
  opts: { includeForks: boolean; includeArchived: boolean },
): Promise<RepoInfo[]> {
  const path = owner.kind === 'user'
    ? '/user/repos?affiliation=owner&per_page=100'
    : `/orgs/${encodeURIComponent(owner.login)}/repos?type=all&per_page=100`;
  const repos = await client.paginate<RepoJson>(path);
  return repos
    .filter((r) => (opts.includeForks || !r.fork) && (opts.includeArchived || !r.archived))
    .map((r) => ({
      fullName: r.full_name,
      isPrivate: r.private,
      isFork: r.fork,
      isArchived: r.archived,
      defaultBranch: r.default_branch ?? null,
      pushedAt: r.pushed_at ?? null,
    }))
    .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
}
