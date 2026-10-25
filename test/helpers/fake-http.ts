import type { PublicFetch } from '../../src/core/http/public-client.js';
import type { FakeResponse as FakeFetchResponse } from './fake-fetch.js';

export interface FakeResponse extends FakeFetchResponse {
  /** Sent as is, as text/plain, instead of `body` as JSON. */
  text?: string;
  statusText?: string;
}

/** One response for every call, a list served in order (one per call), or a function of the JSON request body. */
export type FakeHttpRoute = FakeResponse | FakeResponse[] | ((body: unknown) => FakeResponse);

export interface FakeHttpCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The request body, parsed as JSON; undefined when there was none. */
  body: unknown;
}

/**
 * A fake public API. Routes are keyed by method and full URL, for example
 * `POST https://api.osv.dev/v1/querybatch`. Unknown routes return 404.
 */
export function fakeHttp(routes: Record<string, FakeHttpRoute>): PublicFetch & { calls: FakeHttpCall[] } {
  const calls: FakeHttpCall[] = [];
  const served = new Map<string, number>();
  const fetch: PublicFetch = async (url, init) => {
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, headers: { ...init.headers }, body });
    const key = `${init.method} ${url}`;
    const route = Object.hasOwn(routes, key) ? routes[key] : undefined;
    let r: FakeResponse;
    if (route === undefined) {
      r = { status: 404, body: { error: 'Not Found' } };
    } else if (typeof route === 'function') {
      r = route(body);
    } else if (Array.isArray(route)) {
      const i = served.get(key) ?? 0;
      served.set(key, i + 1);
      if (i >= route.length) throw new Error(`fakeHttp: no response left for ${key} (call ${i + 1})`);
      r = route[i]!;
    } else {
      r = route;
    }
    if (r.networkError) throw new TypeError('fetch failed');
    const isText = r.text !== undefined;
    return new Response(isText ? r.text : JSON.stringify(r.body ?? null), {
      status: r.status ?? 200,
      statusText: r.statusText ?? '',
      headers: { 'content-type': isText ? 'text/plain' : 'application/json', ...r.headers },
    });
  };
  return Object.assign(fetch, { calls });
}
