import { describe, it, expect, vi } from 'vitest';
import { getGitHubToken, ToolError, type ExecLike } from '../../../src/core/github/token.js';

const NOT_LOGGED_IN = 'GitHub CLI is not logged in. Run `gh auth login`.';

describe('getGitHubToken', () => {
  it('runs gh auth token and trims the output', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: 'gho_abc\n' }));
    expect(await getGitHubToken(exec)).toBe('gho_abc');
    expect(exec).toHaveBeenCalledWith('gh', ['auth', 'token']);
  });

  it('says gh is not installed on ENOENT', async () => {
    const exec: ExecLike = async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); };
    const err = await getGitHubToken(exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ message: 'GitHub CLI (gh) is not installed.' });
  });

  it('says gh is not logged in on a non-zero exit', async () => {
    const exec: ExecLike = async () => { throw Object.assign(new Error('Command failed'), { code: 1 }); };
    const err = await getGitHubToken(exec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ message: NOT_LOGGED_IN });
  });

  it('says gh is not logged in when the output is empty', async () => {
    const err = await getGitHubToken(async () => ({ stdout: '  \n' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toMatchObject({ message: NOT_LOGGED_IN });
  });
});
