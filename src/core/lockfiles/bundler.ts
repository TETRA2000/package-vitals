import type { DepEdge, DepGraph, DepNode, DepRoot, ParseResult } from "./graph.js";

// Gemfile.lock and the Gemfile's groups. Both files come from any repo and are only read as text; the Gemfile is
// Ruby, and nothing in it is evaluated. One pass over the lines, names in Maps, no recursion. What the files don't
// settle makes the graph say less (unknown groups, an unresolved dependency), never more dev-only.

const REGISTRY_REMOTE = "https://rubygems.org/";
const DEV_GROUPS = new Set(["development", "test"]);
/** Stands in for a group the Gemfile names in a way we can't read. It's no development or test group, so the gem counts as runtime. */
const UNKNOWN_GROUP = "?";

const PLATFORM =
  /-(?:x86|x64|i[3-6]86|arm|aarch64|universal|java|jruby|mswin|mingw|darwin|linux|freebsd|solaris)/;

/** The version without its platform suffix: `1.15.4-arm64-darwin` is `1.15.4`. */
const versionOf = (v: string): string => {
  const m = PLATFORM.exec(v);
  return m ? v.slice(0, m.index) : v;
};

// ---- Gemfile ----

type Token =
  | { t: "str" | "sym" | "key" | "ident" | "punct"; v: string };

/** Cuts a `#` comment that isn't inside a quoted string. */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** A coarse reading of Ruby arguments: strings, symbols, `key:`, identifiers, and everything else as punctuation. */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t") {
      i++;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let v = "";
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\" && j + 1 < s.length) j++;
        v += s[j];
        j++;
      }
      out.push({ t: "str", v });
      i = j + 1;
    } else if (c === ":" && (s[i + 1] === '"' || s[i + 1] === "'")) {
      const q = s[i + 1]!;
      let j = i + 2;
      let v = "";
      while (j < s.length && s[j] !== q) v += s[j++];
      out.push({ t: "sym", v });
      i = j + 1;
    } else if (c === ":" && /[A-Za-z_]/.test(s[i + 1] ?? "")) {
      let j = i + 1;
      while (j < s.length && /[\w?!]/.test(s[j]!)) j++;
      out.push({ t: "sym", v: s.slice(i + 1, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /\w/.test(s[j]!)) j++;
      if (s[j] === ":" && s[j + 1] !== ":") {
        out.push({ t: "key", v: s.slice(i, j) });
        i = j + 1;
      } else {
        out.push({ t: "ident", v: s.slice(i, j) });
        i = j;
      }
    } else if (c === "=" && s[i + 1] === ">") {
      out.push({ t: "punct", v: "=>" });
      i += 2;
    } else {
      out.push({ t: "punct", v: c });
      i++;
    }
  }
  return out;
}

/** The group names a list of arguments or a value names. Anything unreadable becomes UNKNOWN_GROUP. */
function namesIn(tokens: Token[]): string[] {
  return tokens.map((k) => (k.t === "str" || k.t === "sym" ? k.v : UNKNOWN_GROUP));
}

/** `group: :x`, `groups: [:x, :y]`, `:group => :x`, `"groups" => [...]` among a gem's options. */
function optionGroups(tokens: Token[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const k = tokens[i]!;
    let valueAt = -1;
    if (k.t === "key" && (k.v === "group" || k.v === "groups")) valueAt = i + 1;
    else if (
      (k.t === "sym" || k.t === "str") &&
      (k.v === "group" || k.v === "groups") &&
      tokens[i + 1]?.t === "punct" &&
      tokens[i + 1]!.v === "=>"
    )
      valueAt = i + 2;
    if (valueAt < 0) continue;
    const first = tokens[valueAt];
    if (first?.t === "punct" && first.v === "[") {
      const items: Token[] = [];
      let j = valueAt + 1;
      for (; j < tokens.length; j++) {
        const t = tokens[j]!;
        if (t.t === "punct" && t.v === "]") break;
        if (t.t === "punct" && t.v === ",") continue;
        items.push(t);
      }
      if (j >= tokens.length) out.push(UNKNOWN_GROUP);
      out.push(...namesIn(items));
    } else if (first) {
      out.push(...namesIn([first]));
    } else {
      out.push(UNKNOWN_GROUP);
    }
  }
  return out;
}

/** The names a `group … do` line gives, after the `group` word. Options such as `optional: true` add none. */
function blockGroups(args: string): string[] {
  const tokens = tokenize(args);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const k = tokens[i]!;
    if (k.t === "str" || k.t === "sym") out.push(k.v);
    else if (k.t === "key") {
      const v = tokens[i + 1];
      if (v && (v.t === "ident" || v.t === "str" || v.t === "sym")) i++;
      else out.push(UNKNOWN_GROUP);
    } else if (k.t === "ident" && !["true", "false", "nil"].includes(k.v)) out.push(UNKNOWN_GROUP);
  }
  return out;
}

const GEM_LINE = /^gem(?:\s*\(\s*|\s+)(['"])([^'"]+)\1(.*)$/;
const GROUP_BLOCK = /^group\b(.*?)\s+do(?:\s*\|[^|]*\|)?$/;
const DO_BLOCK = /(?:^|[\s)\]}])do(?:\s*\|[^|]*\|)?$/;
const OPENER = /^(?:if|unless|case|begin|while|until|def|class|module)\b/;

/** Logical statements: comments cut, blank lines gone, a line ending in `,` or `\` joined to the next. */
function statements(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const raw of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)) {
    const code = stripComment(raw).trim();
    if (code === "" && pending === "") continue;
    const joined = pending === "" ? code : `${pending} ${code}`;
    if (joined.endsWith(",") || joined.endsWith("\\")) {
      pending = joined.endsWith("\\") ? joined.slice(0, -1).trimEnd() : joined;
    } else {
      pending = "";
      if (joined !== "") out.push(joined);
    }
  }
  if (pending !== "") out.push(pending);
  return out;
}

/**
 * Each gem's groups; an empty array is the default group. Null when the blocks don't balance, so the groups can't be trusted.
 * A gem declared more than once keeps `[]` if any declaration is in the default group, else the union.
 */
export function parseGemfileGroups(text: string): Map<string, string[]> | null {
  const declared = new Map<string, string[][]>();
  // One entry per open block: the groups a `group` block adds, empty for any other block.
  const stack: string[][] = [];
  for (const stmt of statements(text)) {
    if (/^end\b/.test(stmt)) {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    const gem = GEM_LINE.exec(stmt);
    if (gem) {
      const groups = [...stack.flat(), ...optionGroups(tokenize(gem[3]!))];
      const list = declared.get(gem[2]!);
      if (list) list.push(groups);
      else declared.set(gem[2]!, [groups]);
      continue;
    }
    const group = GROUP_BLOCK.exec(stmt);
    if (group) {
      stack.push(blockGroups(group[1]!));
    } else if (DO_BLOCK.test(stmt) || OPENER.test(stmt)) {
      stack.push([]);
    }
  }
  if (stack.length > 0) return null;

  const out = new Map<string, string[]>();
  for (const [name, list] of declared) {
    out.set(name, list.some((g) => g.length === 0) ? [] : [...new Set(list.flat())]);
  }
  return out;
}

// ---- Gemfile.lock ----

interface Spec {
  name: string;
  version: string;
  registry: boolean;
  deps: string[];
}

const SPEC_LINE = /^ {4}(\S+) \((.*)\)$/;
const DEP_LINE = /^ {6}([^\s(]+)(?: \(.*\))?$/;
const DIRECT_LINE = /^ {2}([^\s!(]+)!?(?: \(.*\))?$/;

function readLock(text: string): { specs: Spec[]; direct: Set<string> } | "conflict" | "notLock" {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  if (lines.some((l) => l.startsWith("<<<<<<<") || l.startsWith(">>>>>>>"))) return "conflict";

  const specs: Spec[] = [];
  const direct = new Set<string>();
  const byKey = new Map<string, Spec>();
  let section = "";
  let sectionNo = 0;
  let remotes: string[] = [];
  let inSpecs = false;
  let spec: Spec | undefined;
  let hasDependencies = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "") continue;
    if (line[0] !== " ") {
      section = line;
      sectionNo++;
      remotes = [];
      inSpecs = false;
      spec = undefined;
      if (section === "DEPENDENCIES") hasDependencies = true;
      continue;
    }
    if (section === "GEM" || section === "GIT" || section === "PATH") {
      if (line.startsWith("  remote: ")) {
        remotes.push(line.slice("  remote: ".length));
      } else if (line === "  specs:") {
        inSpecs = true;
        spec = undefined;
      } else if (inSpecs && line.startsWith("    ") && line[4] !== " ") {
        const m = SPEC_LINE.exec(line);
        if (!m) {
          spec = undefined;
          continue;
        }
        const version = versionOf(m[2]!);
        const key = `${sectionNo}\0${m[1]}\0${version}`;
        spec = byKey.get(key);
        if (!spec) {
          spec = {
            name: m[1]!,
            version,
            registry:
              section === "GEM" && remotes.length > 0 && remotes.every((r) => r === REGISTRY_REMOTE),
            deps: [],
          };
          byKey.set(key, spec);
          specs.push(spec);
        }
      } else if (inSpecs && spec && line.startsWith("      ") && line[6] !== " ") {
        const m = DEP_LINE.exec(line);
        if (m && !spec.deps.includes(m[1]!)) spec.deps.push(m[1]!);
      }
    } else if (section === "DEPENDENCIES") {
      const m = DIRECT_LINE.exec(line);
      if (m) direct.add(m[1]!);
    }
  }
  return hasDependencies ? { specs, direct } : "notLock";
}

const isDevGroups = (groups: string[] | undefined) =>
  groups !== undefined && groups.length > 0 && groups.every((g) => DEV_GROUPS.has(g));

function build(specs: Spec[], direct: Set<string>, groups: Map<string, string[]> | null): DepGraph {
  const nodes: DepNode[] = specs.map((s, id) => ({
    id,
    name: s.name,
    version: s.version,
    registry: s.registry,
    lockDev: null,
  }));
  const byName = new Map<string, number[]>();
  nodes.forEach((n) => {
    const list = byName.get(n.name);
    if (list) list.push(n.id);
    else byName.set(n.name, [n.id]);
  });

  const unresolved: string[] = [];
  const resolve = (from: string, name: string, kind: DepEdge["kind"], out: DepEdge[]) => {
    const ids = byName.get(name);
    if (!ids) unresolved.push(`${from} > ${name}`);
    else for (const to of ids) out.push({ to, kind });
  };

  const edges: DepEdge[][] = specs.map((s) => {
    const out: DepEdge[] = [];
    for (const d of s.deps) resolve(s.name, d, "prod", out);
    return out;
  });

  const root: DepRoot = { label: ".", path: ".", edges: [] };
  for (const name of direct) {
    resolve(".", name, groups && isDevGroups(groups.get(name)) ? "dev" : "prod", root.edges);
  }

  return { format: "bundler", roots: [root], nodes, edges, unresolved, devKnown: groups !== null };
}

export function parseGemfileLock(lockText: string, gemfileText: string | null): ParseResult {
  try {
    const lock = readLock(lockText);
    if (lock === "conflict") {
      return { status: "error", message: "The lockfile has merge conflict markers." };
    }
    if (lock === "notLock") return { status: "error", message: "Not a Gemfile.lock file." };
    let groups: Map<string, string[]> | null = null;
    if (gemfileText !== null) {
      try {
        groups = parseGemfileGroups(gemfileText);
      } catch {
        groups = null;
      }
    }
    return { status: "ok", graph: build(lock.specs, lock.direct, groups) };
  } catch {
    return { status: "error", message: "Couldn't read this lockfile." };
  }
}
