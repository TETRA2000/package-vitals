import type { Db } from '../db/database.js';
import { GitHubClient, type FetchLike } from '../github/client.js';
import { getAuthenticatedOwner } from '../github/repos.js';
import { getGitHubToken, type ExecLike } from '../github/token.js';
import type { CheckupScope, CheckupSummary } from '../types.js';
import { runCheckup } from './checkup.js';

/** Reads the token from `gh`, finds the signed-in owner, and runs a Checkup. The token never leaves this function. */
export async function runAccountCheckup(
  deps: {
    db: Db;
    exec: ExecLike;
    fetch?: FetchLike;
    now: () => Date;
    onProgress?: (p: { done: number; total: number; repo: string }) => void;
  },
  opts: CheckupScope & { concurrency: number },
): Promise<CheckupSummary> {
  const token = await getGitHubToken(deps.exec);
  const client = new GitHubClient({ token, fetch: deps.fetch });
  const owner = await getAuthenticatedOwner(client);
  return runCheckup({ db: deps.db, client, now: deps.now, onProgress: deps.onProgress }, { owner, ...opts });
}
