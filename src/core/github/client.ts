/**
 * A GET-only GitHub REST client. The app never writes to GitHub, so this
 * client has no way to send any other method.
 */

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<Response>;

/** An HTTP error from the GitHub API. Its message never includes request headers. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly apiMessage: string;
  readonly url: string;

  constructor(status: number, apiMessage: string, url: string) {
    super(`${apiMessage} (HTTP ${status})`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.apiMessage = apiMessage;
    this.url = url;
  }
}

export interface GitHubClientOptions {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
}

export class GitHubClient {
  // A private field, so the token can't end up in logs or JSON.stringify(client).
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxRetries: number;

  constructor(opts: GitHubClientOptions) {
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
    this.#maxRetries = opts.maxRetries ?? 3;
  }

  async getJson<T>(pathOrUrl: string): Promise<T> {
    return (await this.#request(pathOrUrl)).body as T;
  }

  /** Fetches every page by following `Link: rel="next"`. Every page must be a JSON array. */
  async paginate<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    while (next !== null) {
      const { body, response } = await this.#request(next);
      if (!Array.isArray(body)) throw new TypeError(`Expected a JSON array from ${next}`);
      items.push(...(body as T[]));
      next = nextLink(response.headers.get('link'));
    }
    return items;
  }

  async #request(pathOrUrl: string): Promise<{ body: unknown; response: Response }> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : this.#baseUrl + pathOrUrl;
    if (new URL(url).origin !== new URL(this.#baseUrl).origin) {
      throw new Error(`Refusing to send the GitHub token to ${new URL(url).origin}`);
    }
    const headers = {
      Authorization: `Bearer ${this.#token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'package-vitals',
    };
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, { method: 'GET', headers });
      } catch (err) {
        // fetch rejects with a TypeError when the network drops (sleep, Wi-Fi roaming), so back off and try again.
        if (!(err instanceof TypeError) || attempt >= this.#maxRetries) throw err;
        await this.#sleep(backoff(attempt));
        continue;
      }
      if (response.ok) return { body: await response.json(), response };

      const body: unknown = await response.json().catch(() => null);
      const message = body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : response.statusText || 'Request failed';
      const error = new GitHubApiError(response.status, message, url);
      const wait = this.#rateLimitWait(response, message)
        ?? (TRANSIENT_STATUSES.has(response.status) ? backoff(attempt) : null);
      if (wait === null || attempt >= this.#maxRetries) throw error;
      await this.#sleep(wait);
    }
  }

  /** How long to wait before retrying a rate-limited response, or null if it isn't one. */
  #rateLimitWait(response: Response, message: string): number | null {
    if (response.status !== 403 && response.status !== 429) return null;
    const retryAfter = Number(response.headers.get('retry-after') ?? NaN);
    if (Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? NaN);
    if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
      return Math.max(0, reset * 1000 - this.#now() + 1000);
    }
    // A secondary rate limit can arrive without either header; GitHub says to wait at least a minute.
    if (response.status === 429 || /rate limit/i.test(message)) return 60_000;
    return null;
  }
}

/** Gateway errors that usually clear up on their own. Other 5xx responses fail at once. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** 1 s, 4 s, 16 s, … */
function backoff(attempt: number): number {
  return 1000 * 4 ** attempt;
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]*)"/.exec(part);
    if (match && match[2]!.split(/\s+/).includes('next')) return match[1]!;
  }
  return null;
}
