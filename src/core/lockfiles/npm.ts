import type { DepEdge, DepGraph, DepNode, DepRoot, EdgeKind, ParseResult } from './graph.js';
import { isJsonObject, ownField, type JsonObject, type PackageJson } from './package-json.js';

// package-lock.json and npm-shrinkwrap.json, versions 1 to 3. The file comes from any repo and is only read:
// shapes are checked, keys are read through own properties and Maps, and every walk is iterative.
// What the file doesn't settle makes the graph say less (an unresolved dependency, a runtime edge), never more dev-only.

const REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.yarnpkg.com/'];

const error = (message: string): ParseResult => ({ status: 'error', message });

/** A shape npm never writes. Caught in parseNpmLock and reported with a fixed message. */
function malformed(): never {
  throw new Error('malformed lockfile');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** An own field that must be an object when present. */
function objectField(o: JsonObject, key: string): JsonObject | undefined {
  const v = ownField(o, key);
  if (v === undefined) return undefined;
  return isJsonObject(v) ? v : malformed();
}

/** The names in a dependency map, which npm always writes as name → string. */
function depNames(o: JsonObject, key: string): string[] {
  const entries = Object.entries(objectField(o, key) ?? {});
  for (const [, spec] of entries) if (typeof spec !== 'string') malformed();
  return entries.map(([name]) => name);
}

const fromRegistry = (resolved: unknown) =>
  resolved === undefined || (typeof resolved === 'string' && REGISTRIES.some((r) => resolved.startsWith(r)));

/** A declared dependency. A missing optional one is expected; a missing required one is unresolved. */
interface Declared {
  name: string;
  kind: EdgeKind;
  optional: boolean;
}

function declare(
  prod: Iterable<string>,
  dev: Iterable<string>,
  optional: Iterable<string>,
  peer: Iterable<string>,
  optionalPeers: ReadonlySet<string>,
): Declared[] {
  // npm lists an optional dependency under dependencies too. It's still optional.
  const optionalNames = new Set(optional);
  const out: Declared[] = [];
  for (const name of prod) if (!optionalNames.has(name)) out.push({ name, kind: 'prod', optional: false });
  for (const name of dev) out.push({ name, kind: 'dev', optional: false });
  for (const name of optionalNames) out.push({ name, kind: 'optional', optional: true });
  for (const name of peer) out.push({ name, kind: 'peer', optional: optionalPeers.has(name) });
  return out;
}

function optionalPeersOf(entry: JsonObject): Set<string> {
  const names = new Set<string>();
  const meta = ownField(entry, 'peerDependenciesMeta');
  if (!isJsonObject(meta)) return names;
  for (const [name, m] of Object.entries(meta)) if (isJsonObject(m) && ownField(m, 'optional') === true) names.add(name);
  return names;
}

/** A lockfile entry's dependencies. Only a root's devDependencies are installed. */
const declaredIn = (entry: JsonObject, isRoot: boolean) =>
  declare(
    depNames(entry, 'dependencies'),
    isRoot ? depNames(entry, 'devDependencies') : [],
    depNames(entry, 'optionalDependencies'),
    depNames(entry, 'peerDependencies'),
    optionalPeersOf(entry),
  );

/** Where a dependency resolved: a node id, a workspace root (no edge, it's a root of its own), or nowhere. */
type Target = number | 'root' | null;

function connect(
  from: string,
  declared: Declared[],
  resolve: (name: string) => Target,
  edges: DepEdge[],
  unresolved: string[],
): void {
  for (const d of declared) {
    const to = resolve(d.name);
    if (to === null) {
      if (!d.optional) unresolved.push(`${from} > ${d.name}`);
    } else if (to !== 'root') {
      edges.push({ to, kind: d.kind });
    }
  }
}

/** What a walk can see, by package name, nearest last. */
class Visible<T> {
  private readonly stacks = new Map<string, T[]>();

  push(name: string, value: T): void {
    const stack = this.stacks.get(name);
    if (stack) stack.push(value);
    else this.stacks.set(name, [value]);
  }

  pop(name: string): void {
    this.stacks.get(name)?.pop();
  }

  nearest(name: string): T | undefined {
    return this.stacks.get(name)?.at(-1);
  }
}

// ---- v2 and v3: the flat `packages` map, keyed by install path ----

type Location =
  | { kind: 'root'; root: DepRoot; entry: JsonObject }
  | { kind: 'node'; id: number; entry: JsonObject }
  | { kind: 'link'; target: string | undefined };

/** A directory on the way to some key. `location` is the entry at exactly this path. */
interface Dir {
  name: string;
  children: Map<string, Dir>;
  location?: Location;
}

function dirAt(top: Dir, segments: string[]): Dir {
  let dir = top;
  for (const name of segments) {
    let child = dir.children.get(name);
    if (!child) {
      child = { name, children: new Map() };
      dir.children.set(name, child);
    }
    dir = child;
  }
  return dir;
}

function parsePackages(data: JsonObject, format: 'npm-v2' | 'npm-v3', packageJson: PackageJson | null): DepGraph {
  const packages = objectField(data, 'packages') ?? malformed();
  const nodes: DepNode[] = [];
  const edges: DepEdge[][] = [];
  const workspaces: DepRoot[] = [];
  const unresolved: string[] = [];
  const byPath = new Map<string, Location>();
  const top: Dir = { name: '', children: new Map() };
  let main: DepRoot | undefined;

  for (const [key, entry] of Object.entries(packages)) {
    if (!isJsonObject(entry)) malformed();
    const segments = key === '' ? [] : key.split('/');
    const nm = segments.lastIndexOf('node_modules');
    const installed = nm !== -1 && nm < segments.length - 1; // a package under some node_modules
    const link = ownField(entry, 'link') === true;
    const name = str(ownField(entry, 'name'));
    let location: Location | undefined;
    if (key === '') {
      main = { label: name ?? packageJson?.name ?? '.', path: '.', edges: [] };
      location = { kind: 'root', root: main, entry };
    } else if (nm === -1 && !link) {
      const root: DepRoot = { label: name ?? key, path: key, edges: [] };
      workspaces.push(root);
      location = { kind: 'root', root, entry };
    } else if (installed && link) {
      location = { kind: 'link', target: str(ownField(entry, 'resolved')) };
    } else if (installed) {
      const id = nodes.length;
      nodes.push({
        id,
        // An alias's entry names the real package.
        name: name ?? segments.slice(nm + 1).join('/'),
        version: str(ownField(entry, 'version')) ?? '',
        registry: fromRegistry(ownField(entry, 'resolved')),
        // devOptional means dev or optional, and optional is runtime.
        lockDev: ownField(entry, 'dev') === true,
      });
      edges.push([]);
      location = { kind: 'node', id, entry };
    }
    // Anything else (a link outside node_modules, a bare node_modules directory) is nothing a lookup reaches.
    if (!location) continue;
    byPath.set(key, location);
    dirAt(top, segments).location = location;
  }
  if (!main) malformed();

  const visible = new Visible<Location>();
  const resolve = (name: string): Target => {
    const found = visible.nearest(name);
    const target = found?.kind === 'link' ? (found.target === undefined ? undefined : byPath.get(found.target)) : found;
    if (target?.kind === 'node') return target.id;
    if (target?.kind === 'root') return 'root';
    return null;
  };

  // Node's lookup from a directory tries <dir>/node_modules/<name>, then the same in each parent directory,
  // skipping directories named node_modules. Walking the directories depth-first with each one's node_modules
  // in view makes every lookup one step, however deep the path.
  const enter = (dir: Dir) => {
    const shown: string[] = [];
    const show = (name: string, d: Dir) => {
      if (d.location?.kind === 'node' || d.location?.kind === 'link') {
        visible.push(name, d.location);
        shown.push(name);
      }
    };
    const modules = dir.name === 'node_modules' ? undefined : dir.children.get('node_modules');
    for (const [name, d] of modules?.children ?? []) {
      if (name.startsWith('@')) for (const [sub, s] of d.children) show(`${name}/${sub}`, s);
      else show(name, d);
    }
    const here = dir.location;
    if (here?.kind === 'root') {
      connect(here.root.label, declaredIn(here.entry, true), resolve, here.root.edges, unresolved);
    } else if (here?.kind === 'node') {
      connect(nodes[here.id]!.name, declaredIn(here.entry, false), resolve, edges[here.id]!, unresolved);
    }
    return { children: dir.children.values(), shown };
  };
  const stack = [enter(top)];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.children.next();
    if (!next.done) {
      stack.push(enter(next.value));
    } else {
      for (const name of frame.shown) visible.pop(name);
      stack.pop();
    }
  }

  return { format, roots: [main, ...workspaces], nodes, edges, unresolved, devKnown: true };
}

// ---- v1: the nested `dependencies` tree ----

function treeNode(id: number, key: string, entry: JsonObject): DepNode {
  let name = key;
  let version = str(ownField(entry, 'version')) ?? '';
  // An alias records its real package as npm:<name>@<version>.
  const at = version.lastIndexOf('@');
  if (version.startsWith('npm:') && at > 'npm:'.length) {
    name = version.slice('npm:'.length, at);
    version = version.slice(at + 1);
  }
  return {
    id,
    name,
    version,
    // git, path, and URL dependencies keep their source in `version`, often with no `resolved`.
    registry: fromRegistry(ownField(entry, 'resolved')) && !version.includes(':'),
    lockDev: ownField(entry, 'dev') === true,
  };
}

function parseTree(data: JsonObject, packageJson: PackageJson | null): DepGraph {
  const nodes: DepNode[] = [];
  const edges: DepEdge[][] = [];
  const unresolved: string[] = [];
  const visible = new Visible<number>();
  const resolve = (name: string): Target => visible.nearest(name) ?? null;

  // Adds the packages of one `dependencies` map and brings them into view.
  const open = (deps: JsonObject | undefined) => {
    const kids: { key: string; id: number; entry: JsonObject }[] = [];
    for (const [key, entry] of Object.entries(deps ?? {})) {
      if (!isJsonObject(entry)) malformed();
      const id = nodes.length;
      nodes.push(treeNode(id, key, entry));
      edges.push([]);
      visible.push(key, id);
      kids.push({ key, id, entry });
    }
    return { kids, i: 0 };
  };

  const stack = [open(objectField(data, 'dependencies'))];
  const roots: DepRoot[] = [];
  if (packageJson) {
    const root: DepRoot = { label: str(ownField(data, 'name')) ?? packageJson.name ?? '.', path: '.', edges: [] };
    const declared = declare(
      packageJson.dependencies.keys(),
      packageJson.devDependencies.keys(),
      packageJson.optionalDependencies.keys(),
      packageJson.peerDependencies.keys(),
      new Set(),
    );
    connect(root.label, declared, resolve, root.edges, unresolved);
    roots.push(root);
  }

  // Depth-first, so an entry's requires resolve in its own dependencies, then each ancestor's, then the top level.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.i === frame.kids.length) {
      for (const { key } of frame.kids) visible.pop(key);
      stack.pop();
      continue;
    }
    const { id, entry } = frame.kids[frame.i++]!;
    stack.push(open(objectField(entry, 'dependencies')));
    const requires = depNames(entry, 'requires').map((name): Declared => ({ name, kind: 'prod', optional: false }));
    connect(nodes[id]!.name, requires, resolve, edges[id]!, unresolved);
  }

  return { format: 'npm-v1', roots, nodes, edges, unresolved, devKnown: true };
}

export function parseNpmLock(text: string, packageJson: PackageJson | null): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return error('Not valid JSON.');
  }
  if (!isJsonObject(data)) return error('Not a package-lock.json file.');
  const version = ownField(data, 'lockfileVersion');
  // Only a whole number goes into the message, so the message never quotes the file.
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) return error('Not a package-lock.json file.');
  if (version !== 1 && version !== 2 && version !== 3) {
    const message = `Unsupported package-lock.json version ${version}.`;
    return { status: 'unsupported', format: `npm-v${version}`, message };
  }
  try {
    const graph =
      version === 1 ? parseTree(data, packageJson) : parsePackages(data, version === 2 ? 'npm-v2' : 'npm-v3', packageJson);
    return { status: 'ok', graph };
  } catch {
    return error("Couldn't read this lockfile.");
  }
}
