import { mapLimit } from '../concurrency.js';
import type { PublicApiClient } from '../http/public-client.js';
import { isJsonObject, type JsonObject } from '../lockfiles/package-json.js';
import type { PackageEcosystem, Severity, SeveritySource } from '../types.js';
import { compareVersions } from '../versions.js';

// Vulnerability lookups through OSV: a querybatch per 1,000 packages, then each matching record once by ID,
// unless the cache holds it at the same `modified`. Only package names and versions are sent. A response in
// the wrong form fails the lookup, so it's never read as "no vulnerabilities". Records are external data,
// so normalizeAdvisory checks every field before using it.

export const OSV_ORIGIN = 'https://api.osv.dev';
export const OSV_BATCH_SIZE = 1000;
/** Rounds of next_page_token follow-ups before the lookup gives up, so a token that never runs out can't loop forever. */
const MAX_PAGES = 100;

export interface OsvPackage { ecosystem: PackageEcosystem; name: string; version: string }
export interface OsvRange { type: string; events: { introduced?: string; fixed?: string; last_affected?: string }[] }
/** One OSV record as it applies to one package. */
export interface OsvAdvisory { id: string; aliases: string[]; summary: string; severity: Severity; severitySource: SeveritySource; ranges: OsvRange[] }
export interface AdvisoryCache { get(id: string): { modified: string; json: string } | null; put(id: string, modified: string, json: string): void }

const OSV_ECOSYSTEMS: Record<PackageEcosystem, string> = { npm: 'npm', rubygems: 'RubyGems' };
/** GHSA's `database_specific.severity`, upper-cased. A Map, so no Object.prototype member is a severity. */
const GHSA_SEVERITIES = new Map<string, Severity>([['CRITICAL', 'critical'], ['HIGH', 'high'], ['MODERATE', 'medium'], ['LOW', 'low']]);
const RANGE_TYPES = new Set(['SEMVER', 'ECOSYSTEM']);
const SUMMARY_LENGTH = 200;

export function osvPackageKey(p: OsvPackage): string {
  // JSON, so no name or version can make two packages share a key.
  return JSON.stringify([p.ecosystem, p.name, p.version]);
}

// ---- lookup ----

interface Query { key: string; pkg: OsvPackage; pageToken: string | null }
interface BatchResult { vulns: { id: string; modified: string }[]; nextPageToken: string | null }

function malformed(): never {
  throw new Error("OSV's response wasn't in the expected form.");
}

export async function lookupOsv(
  client: PublicApiClient,
  packages: OsvPackage[],
  cache: AdvisoryCache,
  opts: { concurrency: number; onProgress?: (done: number, total: number) => void },
): Promise<Map<string, OsvAdvisory[]>> {
  const unique = new Map<string, OsvPackage>();
  for (const p of packages) {
    const key = osvPackageKey(p);
    if (!unique.has(key)) unique.set(key, p);
  }
  const idsByKey = new Map<string, Set<string>>([...unique.keys()].map((key) => [key, new Set()]));
  const modifiedById = new Map<string, string>();
  let done = 0;
  let total = 0;
  const progress = () => opts.onProgress?.(++done, total);

  let queries: Query[] = [...unique].map(([key, pkg]) => ({ key, pkg, pageToken: null }));
  for (let page = 0; queries.length > 0; page++) {
    if (page === MAX_PAGES) throw new Error('OSV kept returning more pages.');
    const batches = chunks(queries, OSV_BATCH_SIZE);
    total += batches.length;
    const results = await mapLimit(batches, opts.concurrency, async (batch) => {
      const json = await client.postJson<unknown>('/v1/querybatch', { queries: batch.map(toQuery) });
      const parsed = readBatch(json, batch.length);
      progress();
      return parsed;
    });
    queries = [];
    results.forEach((batchResults, b) => batchResults.forEach((result, i) => {
      const q = batches[b]![i]!;
      for (const v of result.vulns) {
        idsByKey.get(q.key)!.add(v.id);
        if (!modifiedById.has(v.id)) modifiedById.set(v.id, v.modified);
      }
      if (result.nextPageToken !== null) queries.push({ ...q, pageToken: result.nextPageToken });
    }));
  }

  const records = new Map<string, JsonObject>();
  const stale: string[] = [];
  for (const [id, modified] of modifiedById) {
    const cached = cache.get(id);
    const record = cached !== null && cached.modified === modified ? parseRecord(cached.json, id) : null;
    if (record !== null) records.set(id, record);
    else stale.push(id);
  }
  total += stale.length;
  await mapLimit(stale, opts.concurrency, async (id) => {
    const record = await client.getJson<unknown>(`/v1/vulns/${encodeURIComponent(id)}`);
    if (!isRecordOf(record, id)) malformed();
    cache.put(id, modifiedById.get(id)!, JSON.stringify(record));
    records.set(id, record);
    progress();
  });

  const found = new Map<string, OsvAdvisory[]>();
  for (const [key, pkg] of unique) found.set(key, [...idsByKey.get(key)!].map((id) => normalizeAdvisory(records.get(id), pkg)));
  return found;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const toQuery = (q: Query) => ({
  package: { name: q.pkg.name, ecosystem: OSV_ECOSYSTEMS[q.pkg.ecosystem] },
  version: q.pkg.version,
  ...(q.pageToken === null ? {} : { page_token: q.pageToken }),
});

/** A querybatch response: one result per query, each `{}` or a list of `{ id, modified }`. */
function readBatch(json: unknown, size: number): BatchResult[] {
  const results = isJsonObject(json) && Array.isArray(json.results) ? json.results : malformed();
  if (results.length !== size) malformed();
  return results.map((r: unknown): BatchResult => {
    if (!isJsonObject(r)) return malformed();
    const vulns = r.vulns ?? [];
    const token = r.next_page_token ?? '';
    if (!Array.isArray(vulns) || typeof token !== 'string') return malformed();
    return {
      vulns: vulns.map((v: unknown) =>
        isJsonObject(v) && typeof v.id === 'string' && v.id !== '' && typeof v.modified === 'string'
          ? { id: v.id, modified: v.modified }
          : malformed()),
      nextPageToken: token === '' ? null : token,
    };
  });
}

const isRecordOf = (v: unknown, id: string): v is JsonObject => isJsonObject(v) && v.id === id;

/** A cached record, or null when it no longer parses as the record for `id`. */
function parseRecord(json: string, id: string): JsonObject | null {
  try {
    const record: unknown = JSON.parse(json);
    return isRecordOf(record, id) ? record : null;
  } catch {
    return null;
  }
}

// ---- normalization ----

export function normalizeAdvisory(json: unknown, p: OsvPackage): OsvAdvisory {
  const j = isJsonObject(json) ? json : {};
  const id = typeof j.id === 'string' ? j.id : '';
  const aliases = Array.isArray(j.aliases) ? j.aliases.filter((a): a is string => typeof a === 'string') : [];
  return { id, aliases, summary: summaryOf(j, id), ...severityOf(j, id), ranges: rangesFor(j, p) };
}

function severityOf(j: JsonObject, id: string): { severity: Severity; severitySource: SeveritySource } {
  const ds = j.database_specific;
  const named = isJsonObject(ds) && typeof ds.severity === 'string' ? GHSA_SEVERITIES.get(ds.severity.toUpperCase()) : undefined;
  if (named !== undefined) return { severity: named, severitySource: 'advisory' };
  // A malicious package carries no severity, and having one installed is as bad as it gets.
  if (id.startsWith('MAL-')) return { severity: 'critical', severitySource: 'malware' };
  // Without a severity, assume the worst rather than play it down.
  return { severity: 'critical', severitySource: 'assumed' };
}

function summaryOf(j: JsonObject, id: string): string {
  if (typeof j.summary === 'string' && j.summary.trim() !== '') return j.summary.trim();
  const line = typeof j.details === 'string' ? j.details.trim().split(/\r?\n/, 1)[0]!.trim() : '';
  return line !== '' ? cut(line, SUMMARY_LENGTH) : id;
}

/** The first `max` code points of `s`, so an emoji is never split in half. */
function cut(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n++ === max) break;
    out += ch;
  }
  return out;
}

/** The SEMVER and ECOSYSTEM ranges of the `affected` entries for this package. */
function rangesFor(j: JsonObject, p: OsvPackage): OsvRange[] {
  const ecosystem = OSV_ECOSYSTEMS[p.ecosystem];
  const ranges: OsvRange[] = [];
  for (const a of Array.isArray(j.affected) ? j.affected : []) {
    if (!isJsonObject(a) || !isJsonObject(a.package) || a.package.name !== p.name || a.package.ecosystem !== ecosystem) continue;
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      if (!isJsonObject(r) || typeof r.type !== 'string' || !RANGE_TYPES.has(r.type) || !Array.isArray(r.events)) continue;
      ranges.push({ type: r.type, events: r.events.flatMap(readEvent) });
    }
  }
  return ranges;
}

/** An event's `introduced`, `fixed`, and `last_affected`; anything else (such as `limit`) is dropped. */
function readEvent(e: unknown): OsvRange['events'] {
  if (!isJsonObject(e)) return [];
  const event: OsvRange['events'][number] = {};
  for (const k of ['introduced', 'fixed', 'last_affected'] as const) {
    const v = e[k];
    if (typeof v === 'string') event[k] = v;
  }
  return Object.keys(event).length > 0 ? [event] : [];
}

// ---- ranges ----

/** `introduced` up to `end`, which `fixed` closes exclusively and `last_affected` inclusively; null when never closed. */
interface Interval { introduced: string; end: { kind: 'fixed' | 'last_affected'; version: string } | null }

/** A range's events walked in order. `introduced: '0'` means from the start. */
function intervals(range: OsvRange): Interval[] {
  const out: Interval[] = [];
  let open: string | null = null;
  for (const e of range.events) {
    if (e.introduced !== undefined) {
      // A second `introduced` inside an open interval doesn't start a new one.
      open ??= e.introduced;
    } else if (open !== null && e.fixed !== undefined) {
      out.push({ introduced: open, end: { kind: 'fixed', version: e.fixed } });
      open = null;
    } else if (open !== null && e.last_affected !== undefined) {
      out.push({ introduced: open, end: { kind: 'last_affected', version: e.last_affected } });
      open = null;
    }
  }
  if (open !== null) out.push({ introduced: open, end: null });
  return out;
}

/** Null when a bound can't be compared with `version`. */
function contains(ecosystem: PackageEcosystem, version: string, i: Interval): boolean | null {
  const fromStart = i.introduced === '0';
  const lower = fromStart ? 0 : compareVersions(ecosystem, version, i.introduced);
  const upper = i.end === null ? null : compareVersions(ecosystem, version, i.end.version);
  if (lower === null || (i.end !== null && upper === null)) return null;
  if (lower < 0) return false;
  return i.end === null || (i.end.kind === 'fixed' ? upper! < 0 : upper! <= 0);
}

/**
 * The version that fixes `version`, or null when it isn't affected or has no fix. When intervals overlap,
 * it's the highest of their fixes, and null when one of them has none.
 */
export function osvFixedVersion(a: OsvAdvisory, ecosystem: PackageEcosystem, version: string): string | null {
  let fix: string | null = null;
  for (const range of a.ranges) {
    for (const i of intervals(range)) {
      if (contains(ecosystem, version, i) !== true) continue;
      if (i.end === null || i.end.kind !== 'fixed') return null;
      if (fix === null || (compareVersions(ecosystem, i.end.version, fix) ?? 0) > 0) fix = i.end.version;
    }
  }
  return fix;
}

/** Every interval as `>= a, < b`, `< b`, `>= a, <= c`, `<= c`, `>= a`, or `all versions`, joined with `; `. */
export function osvRangeText(a: OsvAdvisory): string | null {
  const texts = new Set<string>();
  for (const range of a.ranges) {
    for (const i of intervals(range)) {
      const lower = i.introduced === '0' ? [] : [`>= ${i.introduced}`];
      const upper = i.end === null ? [] : [`${i.end.kind === 'fixed' ? '<' : '<='} ${i.end.version}`];
      texts.add([...lower, ...upper].join(', ') || 'all versions');
    }
  }
  return texts.size > 0 ? [...texts].join('; ') : null;
}
