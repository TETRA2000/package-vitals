import { STATUS_CODES } from 'node:http';

/**
 * A client for public, credential-free APIs (OSV, the npm registry, RubyGems),
 * pinned to one origin. It never sends an Authorization header; the GitHub
 * token lives only in GitHubClient.
 */

export type PublicFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
) => Promise<Response>;

/** An HTTP error from a public API. Its message never includes the response body. */
export class PublicApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, statusText: string, url: string) {
    // HTTP/2 servers send no reason phrase, so the status code's name stands in for it.
    super(`${statusText || STATUS_CODES[status] || 'Request failed'} (HTTP ${status})`);
    this.name = 'PublicApiError';
    this.status = status;
    this.url = url;
  }
}

export interface PublicApiClientOptions {
  origin: string;
  fetch?: PublicFetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class PublicApiClient {
  readonly #origin: string;
  readonly #fetch: PublicFetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;

  constructor(opts: PublicApiClientOptions) {
    this.#origin = new URL(opts.origin).origin;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxRetries = opts.maxRetries ?? 3;
  }

  async getJson<T>(path: string, accept = 'application/json'): Promise<T> {
    return this.#json(await this.#request('GET', path, accept));
  }

  async getText(path: string): Promise<string> {
    return (await this.#request('GET', path, 'text/plain')).text();
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.#json(await this.#request('POST', path, 'application/json', JSON.stringify(body)));
  }

  async #json<T>(response: Response): Promise<T> {
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`The response from ${this.#origin} wasn't valid JSON.`);
    }
  }

  /** A path such as `/v1/querybatch`, resolved on the origin. Anything that could leave it is refused. */
  #url(path: string): string {
    const url = path.startsWith('/') && !path.startsWith('//') ? new URL(path, this.#origin) : null;
    if (url === null || url.origin !== this.#origin) throw new Error(`Refusing a request outside ${this.#origin}`);
    return url.href;
  }

  async #request(method: 'GET' | 'POST', path: string, accept: string, body?: string): Promise<Response> {
    const url = this.#url(path);
    const headers: Record<string, string> = { 'User-Agent': 'package-vitals', Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, body === undefined ? { method, headers } : { method, headers, body });
      } catch (err) {
        // fetch rejects with a TypeError when the network drops, so back off and try again.
        if (!(err instanceof TypeError) || attempt >= this.#maxRetries) throw err;
        await this.#sleep(backoff(attempt));
        continue;
      }
      if (response.ok) return response;

      // The body is never read, so it can't end up in an error; cancelling it frees the connection.
      await response.body?.cancel().catch(() => {});
      const error = new PublicApiError(response.status, response.statusText, url);
      if (!RETRIED_STATUSES.has(response.status) || attempt >= this.#maxRetries) throw error;
      await this.#sleep(retryAfter(response) ?? backoff(attempt));
    }
  }
}

/** Rate limiting and gateway errors that usually clear up on their own. Other errors fail at once. */
const RETRIED_STATUSES = new Set([429, 502, 503, 504]);

/** 1 s, 4 s, 16 s, … */
function backoff(attempt: number): number {
  return 1000 * 4 ** attempt;
}

/** A 429's `Retry-After` in milliseconds when it's a number of seconds (not a date), otherwise null. */
function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  return response.status === 429 && value !== null && /^\d+$/.test(value) ? Number(value) * 1000 : null;
}
