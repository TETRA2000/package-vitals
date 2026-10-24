import { describe, it, expect, vi } from 'vitest';
import { GitHubClient, GitHubApiError } from '../../../src/core/github/client.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';

const TOKEN = 't0k3n-secret';

describe('GitHubClient', () => {
  it('sends auth and API headers with GET', async () => {
    const f = fakeFetch({ '/user': { body: { login: 'TETRA2000' } } });
    await new GitHubClient({ token: TOKEN, fetch: f }).getJson('/user');
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.github.com/user' });
    expect(f.calls[0]!.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'package-vitals' });
  });

  it('follows Link rel="next" across pages', async () => {
    const next = (p: number) => ({ link: `<https://api.github.com/items?per_page=2&page=${p}>; rel="next"` });
    const f = fakeFetch({
      '/items?per_page=2': { body: [1, 2], headers: next(2) },
      '/items?per_page=2&page=2': { body: [3, 4], headers: next(3) },
      '/items?per_page=2&page=3': { body: [5] } });
    expect(await new GitHubClient({ token: TOKEN, fetch: f }).paginate<number>('/items?per_page=2')).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a page that is not an array', async () => {
    const f = fakeFetch({ '/items': { body: { message: 'not a list' } } });
    await expect(new GitHubClient({ token: TOKEN, fetch: f }).paginate('/items')).rejects.toBeInstanceOf(TypeError);
  });

  it('never sends the token to another origin', async () => {
    const f = fakeFetch({ '/items': { body: [1], headers: { link: '<https://evil.example/items?page=2>; rel="next"' } } });
    await expect(new GitHubClient({ token: TOKEN, fetch: f }).paginate('/items')).rejects.toThrow('Refusing');
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.github.com/items']);
  });

  it('throws GitHubApiError without leaking the token', async () => {
    const err = (await new GitHubClient({ token: TOKEN, fetch: fakeFetch({}) }).getJson('/nope').catch((e: unknown) => e)) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ status: 404, apiMessage: 'Not Found', message: 'Not Found (HTTP 404)' });
    expect(`${err} ${err.stack} ${JSON.stringify(err)}`).not.toContain(TOKEN);
  });

  it('waits for the primary rate limit reset, then retries', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = fakeFetch({ '/user': [
      { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1010' } },
      { body: { login: 'TETRA2000' } }] });
    const c = new GitHubClient({ token: TOKEN, fetch: f, sleep, now: () => 1_000_000 });
    expect(await c.getJson('/user')).toEqual({ login: 'TETRA2000' });
    expect(sleep).toHaveBeenCalledWith(11_000);
  });

  it('honours retry-after on 429', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = fakeFetch({ '/user': [
      { status: 429, body: { message: 'Too Many Requests' }, headers: { 'retry-after': '3' } },
      { body: { login: 'TETRA2000' } }] });
    const c = new GitHubClient({ token: TOKEN, fetch: f, sleep });
    expect(await c.getJson('/user')).toEqual({ login: 'TETRA2000' });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('waits a minute for a secondary rate limit that has no headers, then retries', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = fakeFetch({ '/user': [
      { status: 403, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } },
      { body: { login: 'TETRA2000' } }] });
    expect(await new GitHubClient({ token: TOKEN, fetch: f, sleep }).getJson('/user')).toEqual({ login: 'TETRA2000' });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('waits a minute on a 429 that has no headers', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = fakeFetch({ '/user': [{ status: 429, body: { message: 'Too Many Requests' } }, { body: { login: 'TETRA2000' } }] });
    expect(await new GitHubClient({ token: TOKEN, fetch: f, sleep }).getJson('/user')).toEqual({ login: 'TETRA2000' });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it('does not retry a permission 403', async () => {
    // Review Focus 2: a 403 that is not a rate limit is an error, not a wait.
    const sleep = vi.fn(async (_ms: number) => {});
    const f = fakeFetch({ '/repos/TETRA2000/a/dependabot/alerts?per_page=100': {
      status: 403, body: { message: 'Resource not accessible by integration' }, headers: { 'x-ratelimit-remaining': '4999' } } });
    const err = await new GitHubClient({ token: TOKEN, fetch: f, sleep })
      .getJson('/repos/TETRA2000/a/dependabot/alerts?per_page=100').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ status: 403, apiMessage: 'Resource not accessible by integration' });
    expect(sleep).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const limited = { status: 429, body: { message: 'Too Many Requests' }, headers: { 'retry-after': '1' } };
    const f = fakeFetch({ '/user': [limited, limited, limited, limited] });
    const err = await new GitHubClient({ token: TOKEN, fetch: f, sleep }).getJson('/user').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ status: 429 });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(f.calls).toHaveLength(4);
  });
});
