/** Builders for GitHub API-shaped JSON. */

export function repoJson(
  fullName: string,
  o: { fork?: boolean; archived?: boolean; private?: boolean; pushed_at?: string } = {},
) {
  return {
    full_name: fullName,
    private: o.private ?? false,
    fork: o.fork ?? false,
    archived: o.archived ?? false,
    default_branch: 'main',
    pushed_at: o.pushed_at ?? '2026-10-01T00:00:00Z',
  };
}
