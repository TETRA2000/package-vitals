import { describe, it, expect, vi } from 'vitest';
import { PublicApiClient, PublicApiError } from '../../../src/core/http/public-client.js';
import { fakeHttp } from '../../helpers/fake-http.js';

const ORIGIN = 'https://api.osv.dev';
const client = (f: ReturnType<typeof fakeHttp>, sleep = vi.fn(async (_ms: number) => {})) =>
  new PublicApiClient({ origin: ORIGIN, fetch: f, sleep });

describe('PublicApiClient', () => {
  it('sends no credentials and stays on its origin', async () => {
    const f = fakeHttp({
      'GET https://api.osv.dev/v1/vulns/GHSA-1': { body: { id: 'GHSA-1' } },
      'GET https://api.osv.dev/-/x': { body: {} },
      'GET https://api.osv.dev/info/rack': { text: '---\n1.0.0 |checksum:abc\n' },
    });
    const c = client(f);
    expect(await c.getJson('/v1/vulns/GHSA-1')).toEqual({ id: 'GHSA-1' });
    await c.getJson('/-/x', 'application/vnd.npm.install-v1+json');
    expect(await c.getText('/info/rack')).toBe('---\n1.0.0 |checksum:abc\n');
    expect(f.calls.map((call) => [call.method, call.url, call.headers])).toEqual([
      ['GET', 'https://api.osv.dev/v1/vulns/GHSA-1', { 'User-Agent': 'package-vitals', Accept: 'application/json' }],
      ['GET', 'https://api.osv.dev/-/x', { 'User-Agent': 'package-vitals', Accept: 'application/vnd.npm.install-v1+json' }],
      ['GET', 'https://api.osv.dev/info/rack', { 'User-Agent': 'package-vitals', Accept: 'text/plain' }],
    ]);
    for (const call of f.calls) expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain('authorization');

    for (const path of ['https://evil.example/x', '//evil.example/x', 'x', '/\\evil.example/x', '']) {
      await expect(c.getJson(path), path).rejects.toThrow(`Refusing a request outside ${ORIGIN}`);
      await expect(c.getText(path), path).rejects.toThrow('Refusing');
      await expect(c.postJson(path, {}), path).rejects.toThrow('Refusing');
    }
    expect(f.calls).toHaveLength(3);
  });

  it('retries network errors, 429, and gateway errors, then gives up', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const url = 'GET https://api.osv.dev/v1/vulns/GHSA-1';
    const f = fakeHttp({ [url]: [{ networkError: true }, { status: 502 }, { status: 503 }, { status: 504 }] });
    const err = await client(f, sleep).getJson('/v1/vulns/GHSA-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicApiError);
    expect(err).toMatchObject({ status: 504 });
    expect(sleep.mock.calls).toEqual([[1000], [4000], [16_000]]);
    expect(f.calls).toHaveLength(4);

    // A 429 waits its Retry-After seconds; one without the header (or with a date) takes the backoff.
    const sleep2 = vi.fn(async (_ms: number) => {});
    const f2 = fakeHttp({ [url]: [
      { status: 429, headers: { 'retry-after': '7' } },
      { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
      { status: 429 },
      { body: { id: 'GHSA-1' } }] });
    expect(await client(f2, sleep2).getJson('/v1/vulns/GHSA-1')).toEqual({ id: 'GHSA-1' });
    expect(sleep2.mock.calls).toEqual([[7000], [4000], [16_000]]);

    // A network error past maxRetries is rethrown as is.
    const down = { networkError: true } as const;
    const f3 = fakeHttp({ [url]: [down, down] });
    const c3 = new PublicApiClient({ origin: ORIGIN, fetch: f3, sleep: vi.fn(async () => {}), maxRetries: 1 });
    await expect(c3.getJson('/v1/vulns/GHSA-1')).rejects.toThrow(TypeError);
    expect(f3.calls).toHaveLength(2);

    // Other errors fail at once.
    for (const status of [400, 403, 404, 500]) {
      const sleep4 = vi.fn(async (_ms: number) => {});
      const f4 = fakeHttp({ [url]: { status } });
      await expect(client(f4, sleep4).getJson('/v1/vulns/GHSA-1')).rejects.toMatchObject({ status });
      expect(sleep4).not.toHaveBeenCalled();
      expect(f4.calls).toHaveLength(1);
    }
  });

  it('never follows a redirect', async () => {
    // The default fetch: the global fetch is asked for `redirect: 'manual'`, and its 307 fails at once.
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 307, headers: { location: 'http://evil.example/v1/querybatch' } });
    });
    try {
      const sleep = vi.fn(async (_ms: number) => {});
      const err = await new PublicApiClient({ origin: ORIGIN, sleep }).postJson('/v1/querybatch', { queries: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PublicApiError);
      expect(err).toMatchObject({ status: 307, url: 'https://api.osv.dev/v1/querybatch', message: 'Temporary Redirect (HTTP 307)' });
      expect(seen.map((s) => [s.url, s.init.method, s.init.redirect])).toEqual([['https://api.osv.dev/v1/querybatch', 'POST', 'manual']]);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    // Every 3xx fails after one request, without its body being read and without a request anywhere else.
    for (const status of [301, 302, 303, 307, 308]) {
      const sleep = vi.fn(async (_ms: number) => {});
      const f = fakeHttp({ 'POST https://api.osv.dev/v1/querybatch': {
        status, headers: { location: 'https://evil.example/v1/querybatch' }, body: { results: [{}] } } });
      const err = (await client(f, sleep).postJson('/v1/querybatch', { queries: [] }).catch((e: unknown) => e)) as PublicApiError;
      expect(err).toBeInstanceOf(PublicApiError);
      expect(err.status).toBe(status);
      expect(`${err} ${JSON.stringify(err)}`).not.toContain('results');
      expect(f.calls.map((c) => c.url)).toEqual(['https://api.osv.dev/v1/querybatch']);
      expect(sleep).not.toHaveBeenCalled();
    }

    // Some fetch implementations answer `manual` with an opaque redirect: status 0, no headers, no body.
    const readBody = () => {
      throw new Error('the body was read');
    };
    const opaque = { ok: false, status: 0, statusText: '', type: 'opaqueredirect', headers: new Headers(), body: null,
      text: readBody, json: readBody } as unknown as Response;
    let calls = 0;
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new PublicApiClient({ origin: ORIGIN, fetch: async () => (calls++, opaque), sleep });
    await expect(c.getText('/info/rack')).rejects.toMatchObject({ name: 'PublicApiError', status: 0, message: 'Request failed (HTTP 0)' });
    await expect(c.getJson('/info/rack')).rejects.toMatchObject({ name: 'PublicApiError', status: 0 });
    expect(calls).toBe(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('posts JSON', async () => {
    const f = fakeHttp({ 'POST https://api.osv.dev/v1/querybatch': (body) => ({ body: { echo: body } }) });
    const sent = { queries: [{ package: { name: 'minimist', ecosystem: 'npm' }, version: '0.0.8' }] };
    expect(await client(f).postJson('/v1/querybatch', sent)).toEqual({ echo: sent });
    expect(f.calls).toEqual([{
      url: 'https://api.osv.dev/v1/querybatch',
      method: 'POST',
      headers: { 'User-Agent': 'package-vitals', Accept: 'application/json', 'Content-Type': 'application/json' },
      body: sent,
    }]);
  });

  it('errors carry the status, never the body', async () => {
    const secret = 'internal stack trace at /srv/osv';
    const f = fakeHttp({
      'GET https://api.osv.dev/a': { status: 404, body: { message: secret } },
      'GET https://api.osv.dev/b': { status: 400, statusText: 'Too Many Queries', body: secret },
      'GET https://api.osv.dev/c': { status: 599, text: secret },
      'GET https://api.osv.dev/d': { text: `<html>${secret}</html>` },
    });
    const c = client(f);
    const a = (await c.getJson('/a').catch((e: unknown) => e)) as PublicApiError;
    expect(a).toBeInstanceOf(PublicApiError);
    // HTTP/2 servers send no reason phrase, so the status code's name stands in.
    expect(a).toMatchObject({ status: 404, url: 'https://api.osv.dev/a', message: 'Not Found (HTTP 404)', name: 'PublicApiError' });
    expect(await c.getJson('/b').catch((e: unknown) => e)).toMatchObject({ status: 400, message: 'Too Many Queries (HTTP 400)' });
    const unknown = (await c.getText('/c').catch((e: unknown) => e)) as PublicApiError;
    expect(unknown).toMatchObject({ status: 599, message: 'Request failed (HTTP 599)' });

    const notJson = (await c.getJson('/d').catch((e: unknown) => e)) as Error;
    expect(notJson.message).toBe("The response from https://api.osv.dev wasn't valid JSON.");

    for (const e of [a, unknown, notJson]) expect(`${e} ${e.stack} ${JSON.stringify(e)}`).not.toContain(secret);
  });
});
