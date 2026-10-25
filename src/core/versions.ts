import type { PackageEcosystem } from './types.js';

// Version order for npm (SemVer 2.0) and RubyGems (Gem::Version), plus GHSA range checks.

interface NpmVersion {
  core: [number, number, number];
  pre: string[];
}

const SEMVER =
  /^[v=]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function parseNpm(v: string): NpmVersion | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

const isNumeric = (s: string) => /^\d+$/.test(s);

function compareNpm(a: NpmVersion, b: NpmVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  }
  // A version without a prerelease outranks one with it.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  const n = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const x = a.pre[i]!;
    const y = b.pre[i]!;
    if (x === y) continue;
    if (isNumeric(x) && isNumeric(y)) return Number(x) - Number(y);
    if (isNumeric(x)) return -1;
    if (isNumeric(y)) return 1;
    return x < y ? -1 : 1;
  }
  return a.pre.length - b.pre.length;
}

type GemSegment = number | string;

// Gem::Version's pattern: dot-separated alphanumerics, then optional `-` parts.
const GEM_VERSION = /^[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseGem(v: string): GemSegment[] | null {
  const s = v.trim();
  if (!GEM_VERSION.test(s)) return null;
  const parts = s.replace(/-/g, '.pre.').match(/[0-9]+|[a-zA-Z]+/g) ?? [];
  return parts.map((p) => (isNumeric(p) ? Number(p) : p));
}

function compareGem(a: GemSegment[], b: GemSegment[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    // A letter segment sorts before any number.
    if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : 1;
    return typeof x === 'string' ? -1 : 1;
  }
  return 0;
}

/** Negative, zero or positive; null when either version isn't valid for the ecosystem. */
export function compareVersions(ecosystem: PackageEcosystem, a: string, b: string): number | null {
  if (ecosystem === 'npm') {
    const x = parseNpm(a);
    const y = parseNpm(b);
    return x && y ? compareNpm(x, y) : null;
  }
  const x = parseGem(a);
  const y = parseGem(b);
  return x && y ? compareGem(x, y) : null;
}

/** No SemVer prerelease for npm, no letter segment for RubyGems. Invalid versions are not stable. */
export function isStableVersion(ecosystem: PackageEcosystem, v: string): boolean {
  if (ecosystem === 'npm') {
    const p = parseNpm(v);
    return p !== null && p.pre.length === 0;
  }
  const p = parseGem(v);
  return p !== null && p.every((s) => typeof s === 'number');
}

const COMPARATOR = /^(<=|>=|<|>|=)\s*(\S+)$/;

/**
 * Whether `version` falls in a GHSA `vulnerable_version_range` such as
 * `>= 1.0.0, < 1.2.6`. Null when the range is missing or unparseable, or the
 * version is invalid.
 */
export function inVulnerableRange(
  ecosystem: PackageEcosystem,
  version: string,
  range: string | null,
): boolean | null {
  if (range === null || range.trim() === '') return null;
  let result = true;
  for (const part of range.split(',')) {
    const m = COMPARATOR.exec(part.trim());
    if (!m) return null;
    const cmp = compareVersions(ecosystem, version, m[2]!);
    if (cmp === null) return null;
    const holds =
      m[1] === '<' ? cmp < 0 : m[1] === '<=' ? cmp <= 0 : m[1] === '>' ? cmp > 0 : m[1] === '>=' ? cmp >= 0 : cmp === 0;
    if (!holds) result = false;
  }
  return result;
}
