import type {
  DepEdge,
  DepGraph,
  DepNode,
  DepRoot,
  EdgeKind,
  ParseResult,
} from "./graph.js";
import type { PackageJson } from "./package-json.js";

// yarn.lock from yarn classic (v1). The file comes from any repo and is only read: one pass over the lines,
// descriptors and names in Maps, no recursion. What the file doesn't settle makes the graph say less
// (an unresolved dependency), never more dev-only.

const REGISTRIES = [
  "https://registry.npmjs.org/",
  "https://registry.yarnpkg.com/",
];

/** A line that breaks the file's structure. Caught in parseYarnLock and reported by number, never by content. */
class LineError extends Error {
  constructor(readonly line: number) {
    super("invalid yarn.lock");
  }
}

/** A name or value, bare or double-quoted, starting at `from`. `end` is just past it. */
function readToken(
  s: string,
  from: number,
  stop: string,
  line: number,
): { text: string; end: number } {
  if (s[from] !== '"') {
    let end = from;
    while (end < s.length && !stop.includes(s[end]!)) end++;
    return { text: s.slice(from, end), end };
  }
  let end = from + 1;
  while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
  if (end >= s.length) throw new LineError(line);
  try {
    return { text: JSON.parse(s.slice(from, end + 1)) as string, end: end + 1 };
  } catch {
    throw new LineError(line);
  }
}

/** The descriptors of an entry header (already cut of its trailing colon). */
function descriptorsOf(header: string, line: number): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const { text, end } = readToken(header, i, ",", line);
    if (text === "") throw new LineError(line);
    out.push(text);
    if (end === header.length) return out;
    if (header[end] !== ",") throw new LineError(line);
    i = end + 1;
    while (header[i] === " ") i++;
  }
}

/** Splits `name@range` at the first `@` after position 0: a name never holds one, a range (git URL, alias) can. */
function split(descriptor: string): { name: string; range: string } {
  const at = descriptor.indexOf("@", 1);
  return at > 0
    ? { name: descriptor.slice(0, at), range: descriptor.slice(at + 1) }
    : { name: descriptor, range: "" };
}

/** The package an entry installs. An `npm:<real>@<range>` alias names the real package. */
function packageName(descriptor: string): string {
  const { name, range } = split(descriptor);
  return range.startsWith("npm:")
    ? split(range.slice("npm:".length)).name
    : name;
}

interface Entry {
  descriptors: string[];
  version: string;
  resolved: string | undefined;
  dependencies: [string, string][];
  optionalDependencies: [string, string][];
}

type Section = "dependencies" | "optionalDependencies" | "other" | null;

function readEntries(text: string): Entry[] | "berry" | "conflict" {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(
    /\r?\n/,
  );
  if (lines.some((l) => l.startsWith("<<<<<<<"))) return "conflict";
  if (lines.some((l) => l === "__metadata:")) return "berry";

  const entries: Entry[] = [];
  let entry: Entry | undefined;
  let section: Section = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const no = n + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    let indent = 0;
    while (line[indent] === " ") indent++;
    if (indent === 0) {
      if (!line.endsWith(":")) throw new LineError(no);
      entry = {
        descriptors: descriptorsOf(line.slice(0, -1), no),
        version: "",
        resolved: undefined,
        dependencies: [],
        optionalDependencies: [],
      };
      entries.push(entry);
      section = null;
    } else if (indent === 2 && entry) {
      const rest = line.slice(2);
      if (rest.endsWith(":")) {
        const key = readToken(rest, 0, ":", no);
        if (key.end !== rest.length - 1) throw new LineError(no);
        section =
          key.text === "dependencies" || key.text === "optionalDependencies"
            ? key.text
            : "other";
      } else {
        const key = readToken(rest, 0, " ", no);
        if (rest[key.end] !== " ") throw new LineError(no);
        const value = readToken(rest, key.end + 1, "\n", no);
        if (value.end !== rest.length) throw new LineError(no);
        section = null;
        if (key.text === "version") entry.version = value.text;
        else if (key.text === "resolved") entry.resolved = value.text;
      }
    } else if (indent === 4 && entry && section) {
      if (section === "other") continue;
      const rest = line.slice(4);
      const name = readToken(rest, 0, " ", no);
      if (rest[name.end] !== " ") throw new LineError(no);
      const range = readToken(rest, name.end + 1, "\n", no);
      if (range.end !== rest.length) throw new LineError(no);
      entry[section].push([name.text, range.text]);
    } else {
      throw new LineError(no);
    }
  }
  return entries;
}

const fromRegistry = (resolved: string | undefined) =>
  resolved === undefined || REGISTRIES.some((r) => resolved.startsWith(r));

interface Declared {
  name: string;
  range: string;
  kind: EdgeKind;
  optional: boolean;
}

function parse(
  entries: Entry[],
  roots: { path: string; packageJson: PackageJson }[],
): DepGraph {
  const nodes: DepNode[] = [];
  const edges: DepEdge[][] = [];
  const byDescriptor = new Map<string, number>();
  for (const e of entries) {
    const id = nodes.length;
    nodes.push({
      id,
      name: packageName(e.descriptors[0]!),
      version: e.version,
      registry: fromRegistry(e.resolved),
      lockDev: null,
    });
    edges.push([]);
    for (const d of e.descriptors) {
      if (byDescriptor.has(d)) throw new Error("duplicate descriptor");
      byDescriptor.set(d, id);
    }
  }

  const unresolved: string[] = [];
  const connect = (from: string, declared: Declared[], out: DepEdge[]) => {
    for (const d of declared) {
      const to = byDescriptor.get(`${d.name}@${d.range}`);
      if (to !== undefined) out.push({ to, kind: d.kind });
      else if (!d.optional) unresolved.push(`${from} > ${d.name}`);
    }
  };
  // yarn writes an optional dependency under dependencies too. It's still optional.
  const declare = (
    prod: Iterable<[string, string]>,
    dev: Iterable<[string, string]>,
    optional: Iterable<[string, string]>,
    skip: ReadonlySet<string>,
  ): Declared[] => {
    const optionalNames = new Set<string>();
    const out: Declared[] = [];
    for (const [name, range] of optional) {
      optionalNames.add(name);
      if (!skip.has(name))
        out.push({ name, range, kind: "optional", optional: true });
    }
    for (const [name, range] of prod) {
      if (!optionalNames.has(name) && !skip.has(name))
        out.push({ name, range, kind: "prod", optional: false });
    }
    for (const [name, range] of dev)
      if (!skip.has(name))
        out.push({ name, range, kind: "dev", optional: false });
    return out;
  };
  const none = new Set<string>();

  entries.forEach((e, id) => {
    connect(
      nodes[id]!.name,
      declare(e.dependencies, [], e.optionalDependencies, none),
      edges[id]!,
    );
  });

  // A dependency named like a root is a workspace sibling: a root of its own, not a node.
  const rootNames = new Set<string>();
  for (const r of roots)
    if (r.packageJson.name !== null) rootNames.add(r.packageJson.name);
  const depRoots = roots.map(({ path, packageJson: p }): DepRoot => {
    const root: DepRoot = { label: p.name ?? path, path, edges: [] };
    connect(
      root.label,
      declare(
        p.dependencies,
        p.devDependencies,
        p.optionalDependencies,
        rootNames,
      ),
      root.edges,
    );
    return root;
  });

  return {
    format: "yarn-v1",
    roots: depRoots,
    nodes,
    edges,
    unresolved,
    devKnown: true,
  };
}

export function parseYarnLock(
  text: string,
  roots: { path: string; packageJson: PackageJson }[],
): ParseResult {
  try {
    const entries = readEntries(text);
    if (entries === "conflict")
      return {
        status: "error",
        message: "The lockfile has merge conflict markers.",
      };
    if (entries === "berry") {
      return {
        status: "unsupported",
        format: "yarn-berry",
        message: "Yarn 2+ lockfiles aren't supported yet.",
      };
    }
    return { status: "ok", graph: parse(entries, roots) };
  } catch (e) {
    if (e instanceof LineError)
      return {
        status: "error",
        message: `Not a valid yarn.lock file (line ${e.line}).`,
      };
    return { status: "error", message: "Couldn't read this lockfile." };
  }
}
