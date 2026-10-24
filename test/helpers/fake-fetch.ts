import type { FetchLike } from '../../src/core/github/client.js';

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Rejects the call the way fetch does when the network is down. */
  networkError?: true;
}

/** One response for every call, or a list served in order, one per call. */
export type FakeRoute = FakeResponse | FakeResponse[];

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * A fake GitHub API. Routes are keyed by path plus query string, for example
 * `/user/repos?affiliation=owner&per_page=100`. Unknown routes return 404.
 */
export function fakeFetch(routes: Record<string, FakeRoute>): FetchLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const served = new Map<string, number>();
  const fetch = async (url: string, init: { method: 'GET'; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: { ...init.headers } });
    const u = new URL(url);
    const key = u.pathname + u.search;
    const route = routes[key];
    let r: FakeResponse;
    if (route === undefined) {
      r = { status: 404, body: { message: 'Not Found' } };
    } else if (Array.isArray(route)) {
      const i = served.get(key) ?? 0;
      served.set(key, i + 1);
      if (i >= route.length) throw new Error(`fakeFetch: no response left for ${key} (call ${i + 1})`);
      r = route[i]!;
    } else {
      r = route;
    }
    if (r.networkError) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body ?? null), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  };
  return Object.assign(fetch, { calls });
}
