import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { DepEdge, DepGraph, DepNode, DepRoot, EdgeKind, ParseResult } from './graph.js';
import { ownField, type JsonObject } from './package-json.js';

// pnpm-lock.yaml, lockfile version 9. The file comes from any repo and is only read: aliases are refused, keys are
// checked in one pass, mappings are read through own properties and Maps, and nothing here recurses.
// What the file doesn't settle makes the graph say less (an unresolved dependency), never more dev-only.

const IMPORTER_SECTIONS = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
] as const;
const SNAPSHOT_SECTIONS = [
  ['dependencies', 'prod'],
  ['optionalDependencies', 'optional'],
] as const;

const error = (message: string): ParseResult => ({ status: 'error', message });

/**
 * True when the document holds no alias and no mapping repeats a key, compared as the object key it becomes
 * (`1` and `'1'` are the same key). pnpm never writes an alias, and resolving many of them takes the library
 * quadratic time whatever the alias count, so one fails here, before any is resolved. The library's own key check
 * rescans every earlier key for each new one, so it's off and this one pass replaces it. A key that isn't a plain
 * scalar (a collection, an alias, a date) is something pnpm never writes, and fails too.
 */
function isPlainDocument(contents: unknown): boolean {
  const stack = [contents];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isAlias(node)) return false;
    if (isMap(node)) {
      const keys = new Set<string>();
      for (const { key, value } of node.items) {
        if (!isScalar(key) || (typeof key.value === 'object' && key.value !== null)) return false;
        const name = key.value === null ? '' : String(key.value);
        if (keys.has(name)) return false;
        keys.add(name);
        stack.push(value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) stack.push(item);
    }
  }
  return true;
}

/** A shape pnpm never writes. Caught in parsePnpmLock and reported with a fixed message. */
function malformed(): never {
  throw new Error('malformed lockfile');
}

/** A plain mapping. A YAML 1.1 document can also give a Map, Set, Date, or bytes, none of which pnpm writes. */
const isMapping = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** An own field that must be a mapping when present. */
function mappingField(o: JsonObject, key: string): JsonObject | undefined {
  const v = ownField(o, key);
  if (v === undefined) return undefined;
  return isMapping(v) ? v : malformed();
}

/** A snapshot key: `<name>@<version>`, maybe followed by a peer suffix `(…)`. A name holds an `@` only at its start. */
function splitKey(key: string): { name: string; version: string } {
  const at = key.indexOf('@', 1);
  if (at === -1) malformed();
  const paren = key.indexOf('(', at);
  const version = key.slice(at + 1, paren === -1 ? undefined : paren);
  if (version === '') malformed();
  return { name: key.slice(0, at), version };
}

/**
 * The snapshot a dependency resolves to. An alias's version names the real package (`string-width@4.2.3`) and is the key.
 * A package name never holds a `:`, so a `:` before the `@` means a URL or path (`git+ssh://git@…`), not an alias.
 */
function snapshotKey(name: string, version: string): string {
  const paren = version.indexOf('(');
  const plain = paren === -1 ? version : version.slice(0, paren);
  const at = plain.indexOf('@', 1);
  const alias = at !== -1 && !plain.slice(0, at).includes(':');
  return alias ? version : `${name}@${version}`;
}

/** Only a short dotted number goes into a message, so the message never quotes the file. */
const VERSION_SHOWN = /^\d{1,3}(\.\d{1,3}){0,2}$/;

/** From the registry: resolved by an integrity hash alone, with no tarball URL, git repo, or directory. */
function fromRegistry(entry: unknown): boolean {
  const resolution = isMapping(entry) ? ownField(entry, 'resolution') : undefined;
  return (
    isMapping(resolution) &&
    typeof ownField(resolution, 'integrity') === 'string' &&
    !['tarball', 'type', 'directory'].some((key) => Object.hasOwn(resolution, key))
  );
}

function readGraph(data: JsonObject): DepGraph {
  const importers = mappingField(data, 'importers') ?? {};
  const snapshots = mappingField(data, 'snapshots') ?? {};
  const packages = mappingField(data, 'packages') ?? {};

  // A second line of defence: aliases are refused before toJS, so no dependency map should be met twice.
  // One that is would let a few lines multiply the work.
  const seen = new Set<JsonObject>();
  const depsOf = (o: JsonObject, key: string): [string, unknown][] => {
    const deps = mappingField(o, key);
    if (!deps) return [];
    if (seen.has(deps)) malformed();
    seen.add(deps);
    return Object.entries(deps);
  };

  const nodes: DepNode[] = [];
  const edges: DepEdge[][] = [];
  const bodies: JsonObject[] = [];
  const byKey = new Map<string, number>();
  for (const [key, body] of Object.entries(snapshots)) {
    if (!isMapping(body)) malformed();
    const { name, version } = splitKey(key);
    const id = nodes.length;
    nodes.push({ id, name, version, registry: fromRegistry(ownField(packages, `${name}@${version}`)), lockDev: null });
    edges.push([]);
    bodies.push(body);
    byKey.set(key, id);
  }

  const unresolved: string[] = [];
  const connect = (from: string, name: string, version: string, kind: EdgeKind, out: DepEdge[]) => {
    // A workspace link: the package is a root of its own, or outside this lockfile.
    if (version.startsWith('link:')) return;
    const to = byKey.get(snapshotKey(name, version));
    if (to !== undefined) out.push({ to, kind });
    else if (kind !== 'optional') unresolved.push(`${from} > ${name}`);
  };

  const roots: DepRoot[] = [];
  for (const [path, importer] of Object.entries(importers)) {
    if (!isMapping(importer)) malformed();
    const root: DepRoot = { label: path, path, edges: [] };
    for (const [section, kind] of IMPORTER_SECTIONS) {
      for (const [name, dep] of depsOf(importer, section)) {
        const version = isMapping(dep) ? ownField(dep, 'version') : undefined;
        if (typeof version !== 'string') malformed();
        connect(path, name, version, kind, root.edges);
      }
    }
    roots.push(root);
  }

  // transitivePeerDependencies is ignored: a resolved peer is listed under the dependencies of the package that takes it.
  bodies.forEach((body, id) => {
    for (const [section, kind] of SNAPSHOT_SECTIONS) {
      for (const [name, version] of depsOf(body, section)) {
        if (typeof version !== 'string') malformed();
        connect(nodes[id]!.name, name, version, kind, edges[id]!);
      }
    }
  });

  return { format: 'pnpm-v9', roots, nodes, edges, unresolved, devKnown: true };
}

export function parsePnpmLock(text: string): ParseResult {
  let data: unknown;
  try {
    // What `parse` does, less its warnings, which quote the file to the process, and its quadratic key check.
    const doc = parseDocument(text, { logLevel: 'error', uniqueKeys: false });
    if (doc.errors.length > 0 || !isPlainDocument(doc.contents)) return error('Not valid YAML.');
    data = doc.toJS({ maxAliasCount: 100 }); // the cap is a second line of defence too
  } catch {
    return error('Not valid YAML.');
  }
  try {
    if (!isMapping(data)) return error('Not a pnpm-lock.yaml file.');
    const version = ownField(data, 'lockfileVersion');
    if (version === undefined || version === null) return error('Not a pnpm-lock.yaml file.');
    if (version === '9.0' || version === 9) return { status: 'ok', graph: readGraph(data) };
    const shown = typeof version === 'string' || typeof version === 'number' ? String(version) : '';
    if (!VERSION_SHOWN.test(shown)) {
      return { status: 'unsupported', format: 'pnpm-unknown', message: "This pnpm lockfile version isn't supported yet." };
    }
    return { status: 'unsupported', format: `pnpm-v${shown}`, message: `pnpm lockfile version ${shown} isn't supported yet.` };
  } catch {
    return error("Couldn't read this lockfile.");
  }
}
