import type { FindingFilter, FindingKey, Severity } from '../../core/types.js';
import type { ReportRequest, VitalsApi } from '../shared/api.js';

// Parsers for every argument the renderer sends. The renderer is untrusted, so each parser accepts only
// the exact shape it expects and returns a fresh value built from the checked fields.

/** A renderer call with malformed input. The message names the field and never echoes the input. */
export class IpcInputError extends Error {
  override name = 'IpcInputError';
}

type FindingsRequest = Parameters<VitalsApi['listFindings']>[0];

const SEVERITIES: ReadonlySet<unknown> = new Set<Severity>(['critical', 'high', 'medium', 'low']);
const ECOSYSTEM = /^[a-z0-9_.-]{1,32}$/;

const isId = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 1;

function id(x: unknown, field: string): number {
  if (!isId(x)) throw new IpcInputError(`${field} must be a positive integer.`);
  return x;
}

function nullableId(x: unknown, field: string): number | null {
  if (x !== null && !isId(x)) throw new IpcInputError(`${field} must be null or a positive integer.`);
  return x;
}

function plainObject(x: unknown, field: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new IpcInputError(`${field} must be an object.`);
  const proto: unknown = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) throw new IpcInputError(`${field} must be a plain object.`);
  return x as Record<string, unknown>;
}

/** A plain object whose own keys, symbols included, are exactly `keys`. */
function exactObject(x: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  const o = plainObject(x, field);
  const own = Reflect.ownKeys(o);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(o, k))) {
    throw new IpcInputError(`${field} must have exactly these keys: ${keys.join(', ')}.`);
  }
  return o;
}

function severities(x: unknown, field: string): Severity[] {
  // Spread first: a sparse array's holes would otherwise slip past `every`.
  const list: unknown[] = Array.isArray(x) ? [...x] : [];
  if (list.length === 0 || new Set(list).size !== list.length || !list.every((s) => SEVERITIES.has(s))) {
    throw new IpcInputError(`${field} must be a non-empty list of distinct severities.`);
  }
  return list as Severity[];
}

function ecosystem(x: unknown, field: string): string | null {
  if (x !== null && !(typeof x === 'string' && ECOSYSTEM.test(x))) {
    throw new IpcInputError(`${field} must be null or an ecosystem name.`);
  }
  return x;
}

function findingFilter(x: unknown, field: string): FindingFilter {
  const o = exactObject(x, field, ['severities', 'repoId', 'ecosystem']);
  return {
    severities: severities(o.severities, `${field}.severities`),
    repoId: nullableId(o.repoId, `${field}.repoId`),
    ecosystem: ecosystem(o.ecosystem, `${field}.ecosystem`),
  };
}

export function parseSnapshotId(x: unknown): number {
  return id(x, 'snapshotId');
}

export function parseReportId(x: unknown): number {
  return id(x, 'reportId');
}

export function parseFindingKey(x: unknown): FindingKey {
  const o = exactObject(x, 'key', ['snapshotId', 'repoId', 'number']);
  return { snapshotId: id(o.snapshotId, 'key.snapshotId'), repoId: id(o.repoId, 'key.repoId'), number: id(o.number, 'key.number') };
}

export function parseFindingsRequest(x: unknown): FindingsRequest {
  const o = exactObject(x, 'request', ['snapshotId', 'filter']);
  return { snapshotId: id(o.snapshotId, 'request.snapshotId'), filter: findingFilter(o.filter, 'request.filter') };
}

export function parseReportRequest(x: unknown): ReportRequest {
  const kind = plainObject(x, 'request').kind;
  if (kind === 'account') {
    const o = exactObject(x, 'request', ['kind', 'snapshotId']);
    return { kind, snapshotId: id(o.snapshotId, 'request.snapshotId') };
  }
  if (kind === 'repo') {
    const o = exactObject(x, 'request', ['kind', 'snapshotId', 'repoId']);
    return { kind, snapshotId: id(o.snapshotId, 'request.snapshotId'), repoId: id(o.repoId, 'request.repoId') };
  }
  throw new IpcInputError("request.kind must be 'account' or 'repo'.");
}
