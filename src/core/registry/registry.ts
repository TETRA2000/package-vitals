import { PublicApiError, type PublicApiClient } from '../http/public-client.js';
import { compareVersions } from '../versions.js';

// Public registry lookups: the newest release of a package, and each release's dependencies.
// Requests carry only the package name. A failure is a value, so one package can't fail a Checkup.

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const RUBYGEMS_ORIGIN = 'https://rubygems.org';

export interface RegistryVersion {
  version: string;
  /** Names of the packages this release depends on. */
  dependencies: string[];
  deprecated: boolean;
}

export type LatestLookup = { status: 'ok'; latest: string } | { status: 'not_found' } | { status: 'error'; message: string };

/** Never rejects: a failure is a value, so one package can't fail a Checkup. */
export interface PackageRegistry {
  latest(name: string): Promise<LatestLookup>;
  /** Every release, oldest first; null when the package or its releases can't be read. */
  versions(name: string): Promise<RegistryVersion[] | null>;
}

const UNREADABLE = "Couldn't read the registry's answer.";

class UnreadableAnswer extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
const isNotFound = (err: unknown) => err instanceof PublicApiError && err.status === 404;

async function lookup(read: () => Promise<LatestLookup>): Promise<LatestLookup> {
  try {
    return await read();
  } catch (err) {
    if (isNotFound(err)) return { status: 'not_found' };
    return { status: 'error', message: err instanceof PublicApiError ? err.message : UNREADABLE };
  }
}

async function releases(read: () => Promise<RegistryVersion[]>): Promise<RegistryVersion[] | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** `@scope/name` is sent as `@scope%2Fname`, which the registry needs for scoped names. */
function npmPath(name: string): string {
  const slash = name.indexOf('/');
  if (name.startsWith('@') && slash > 1) {
    return `@${encodeURIComponent(name.slice(1, slash))}%2F${encodeURIComponent(name.slice(slash + 1))}`;
  }
  return encodeURIComponent(name);
}

function sortOldestFirst(ecosystem: 'npm' | 'rubygems', list: RegistryVersion[]): RegistryVersion[] {
  return list
    .filter((r) => compareVersions(ecosystem, r.version, r.version) !== null)
    .sort((a, b) => compareVersions(ecosystem, a.version, b.version)!);
}

export function npmRegistry(client: PublicApiClient): PackageRegistry {
  return {
    latest: (name) =>
      lookup(async () => {
        const tags = await client.getJson<unknown>(`/-/package/${npmPath(name)}/dist-tags`);
        if (!isRecord(tags)) throw new UnreadableAnswer();
        const latest = own(tags, 'latest');
        return typeof latest === 'string' && latest !== '' ? { status: 'ok', latest } : { status: 'not_found' };
      }),

    versions: (name) =>
      releases(async () => {
        const doc = await client.getJson<unknown>(`/${npmPath(name)}`, 'application/vnd.npm.install-v1+json');
        const versions = isRecord(doc) ? own(doc, 'versions') : undefined;
        if (!isRecord(versions)) throw new UnreadableAnswer();
        const list = Object.keys(versions).map((version): RegistryVersion => {
          const manifest = versions[version];
          const m = isRecord(manifest) ? manifest : {};
          const names = new Set<string>();
          for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
            const deps = own(m, field);
            if (isRecord(deps)) for (const dep of Object.keys(deps)) names.add(dep);
          }
          return { version, dependencies: [...names], deprecated: typeof own(m, 'deprecated') === 'string' };
        });
        return sortOldestFirst('npm', list);
      }),
  };
}

export function rubygemsRegistry(client: PublicApiClient): PackageRegistry {
  return {
    latest: (name) =>
      lookup(async () => {
        const answer = await client.getJson<unknown>(`/api/v1/versions/${encodeURIComponent(name)}/latest.json`);
        const version = isRecord(answer) ? own(answer, 'version') : undefined;
        if (typeof version !== 'string') throw new UnreadableAnswer();
        // An unknown gem is a 200 that says "unknown".
        return version === 'unknown' || version === '' ? { status: 'not_found' } : { status: 'ok', latest: version };
      }),

    versions: (name) => releases(async () => parseCompactIndex(await client.getText(`/info/${encodeURIComponent(name)}`))),
  };
}

/**
 * Reads RubyGems' compact index: a `---` line, then `VERSION[-PLATFORM] DEPS|META` lines, where DEPS is
 * `name:requirements` pairs separated by commas. Platform variants of one version merge into one release.
 * Yanked versions aren't listed, so nothing is deprecated. Never throws; a line it can't read is skipped.
 */
export function parseCompactIndex(text: string): RegistryVersion[] {
  const byVersion = new Map<string, Set<string>>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line === '---') continue;
    const space = line.indexOf(' ');
    const token = space === -1 ? line : line.slice(0, space);
    const version = token.split('-')[0]!;
    const rest = space === -1 ? '' : line.slice(space + 1);
    // The separator between dependencies and metadata is required; a line without one isn't an index entry.
    const bar = rest.indexOf('|');
    if (version === '' || (bar === -1 && space !== -1)) continue;
    const names = byVersion.get(version) ?? new Set<string>();
    byVersion.set(version, names);
    for (const entry of (bar === -1 ? '' : rest.slice(0, bar)).split(',')) {
      const dep = entry.slice(0, Math.max(entry.indexOf(':'), 0)).trim();
      if (dep !== '') names.add(dep);
    }
  }
  const list = [...byVersion].map(([version, names]): RegistryVersion => ({ version, dependencies: [...names], deprecated: false }));
  return sortOldestFirst('rubygems', list);
}
