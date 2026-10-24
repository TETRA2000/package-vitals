import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type ExecLike = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/** A missing or unusable outside tool. Its message is meant for the owner. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

const NOT_LOGGED_IN = 'GitHub CLI is not logged in. Run `gh auth login`.';

/** Reads the token from the `gh` login. The token stays in this process. */
export async function getGitHubToken(exec: ExecLike): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await exec('gh', ['auth', 'token']));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') throw new ToolError('GitHub CLI (gh) is not installed.');
    throw new ToolError(NOT_LOGGED_IN);
  }
  const token = stdout.trim();
  if (!token) throw new ToolError(NOT_LOGGED_IN);
  return token;
}

/** The real `ExecLike`: runs a program with no shell and returns its stdout. */
export const execFileText: ExecLike = async (cmd, args) => ({
  stdout: (await promisify(execFile)(cmd, args, { encoding: 'utf8' })).stdout,
});
