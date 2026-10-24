/** A GitHub user or org whose repos are checked. */
export type Owner = { kind: 'user' | 'org'; login: string };

export interface RepoInfo {
  fullName: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
}
