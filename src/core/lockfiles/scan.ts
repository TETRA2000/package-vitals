import { GitHubApiError, type GitHubClient } from '../github/client.js';
import type { PackageEcosystem } from '../types.js';
import { parseGemfileLock } from './bundler.js';
import type { DepGraph, ParseResult } from './graph.js';
import { parseNpmLock } from './npm.js';
import { isJsonObject, readPackageJson, type PackageJson } from './package-json.js';
import { parsePnpmLock } from './pnpm.js';
import { parseYarnLock } from './yarn.js';

// Level 1's file access: one recursive tree listing, then only the lockfiles and their companions as blobs.
// Nothing is cloned and nothing from the repo runs. When the files leave the JS bundler question open,
// the answer counts as a bundler, so a dev-only npm finding is never ruled out on a guess.

export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;
export const MAX_PACKAGE_JSONS = 50;

export interface TreeEntry { path: string; type: string; sha: string; size?: number }
export interface LockfileCandidate { path: string; ecosystem: PackageEcosystem; kind: 'npm' | 'yarn' | 'pnpm' | 'bundler'; sha: string; size: number }
export interface ProjectScan { path: string; ecosystem: PackageEcosystem; blobSha: string; result: ParseResult; jsBundler: string | null }
export interface RepoLockfileScan { status: 'ok' | 'none' | 'empty' | 'error'; error: string | null; truncated: boolean; projects: ProjectScan[] }

interface TreeJson { tree?: TreeEntry[]; truncated?: boolean }

/** A Map, so a file named like an Object.prototype member is never a lockfile. */
const LOCKFILES = new Map<string, Pick<LockfileCandidate, 'ecosystem' | 'kind'>>([
  ['package-lock.json', { ecosystem: 'npm', kind: 'npm' }],
  ['npm-shrinkwrap.json', { ecosystem: 'npm', kind: 'npm' }],
  ['yarn.lock', { ecosystem: 'npm', kind: 'yarn' }],
  ['pnpm-lock.yaml', { ecosystem: 'npm', kind: 'pnpm' }],
  ['Gemfile.lock', { ecosystem: 'rubygems', kind: 'bundler' }],
]);
const SKIPPED_DIRS = new Set(['node_modules', 'vendor']);

const BUNDLER_PACKAGES = ['vite', 'webpack', 'rollup', 'esbuild', 'parcel', 'parcel-bundler', 'next', 'nuxt',
  '@sveltejs/kit', '@remix-run/dev', 'astro', 'gatsby', 'react-scripts', '@vue/cli-service',
  '@angular-devkit/build-angular', 'browserify', '@rspack/core', 'tsup'];
const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const BUNDLER_CONFIG =
  /^(vite|webpack|rollup|next|nuxt|svelte|remix|astro|rspack|tsup|esbuild)\.config\.[cm]?[jt]s$|^gatsby-config\.[cm]?[jt]s$|^\.parcelrc$/;
const BUNDLER_SCRIPT =
  /(^|[^\w-])(vite|webpack|rollup|esbuild|parcel|next|nuxt|nuxi|svelte-kit|remix|astro|gatsby|react-scripts|vue-cli-service|browserify|rspack|tsup)([^\w-]|$)|(^|[^\w-])ng\s+build\b/;
/** Glob syntax workspacePackageJsonPaths reads literally, so a workspace it hides can't be ruled out. */
const UNSUPPORTED_GLOB = /[?[\]{}()\\]/;
// Matching costs patterns × paths, so a package.json with more or longer patterns than this isn't matched at all.
const MAX_WORKSPACE_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 1000;

const failed = (message: string): ParseResult => ({ status: 'error', message });

// ---- paths, in tree form: `/`-separated, relative to the repo, `.` for the top ----

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

const fileIn = (dir: string, name: string) => (dir === '.' ? name : `${dir}/${name}`);

/** `path` relative to `dir`, or null when it isn't under it. */
function under(dir: string, path: string): string | null {
  if (dir === '.') return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}

/** `rel` resolved against `dir`, or null when it leaves the repo. */
function resolvePath(dir: string, rel: string): string | null {
  const out = dir === '.' ? [] : dir.split('/');
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') out.push(segment);
    else if (out.pop() === undefined) return null;
  }
  return out.length === 0 ? '.' : out.join('/');
}

// ---- finding lockfiles ----

export function findLockfiles(tree: TreeEntry[]): LockfileCandidate[] {
  const found = tree.filter(
    (e) => e.type === 'blob' && LOCKFILES.has(basename(e.path)) && !e.path.split('/').some((s) => SKIPPED_DIRS.has(s)),
  );
  // npm installs from npm-shrinkwrap.json and ignores a package-lock.json beside it.
  const shrinkwrapped = new Set(found.filter((e) => basename(e.path) === 'npm-shrinkwrap.json').map((e) => dirname(e.path)));
  return found
    .filter((e) => basename(e.path) !== 'package-lock.json' || !shrinkwrapped.has(dirname(e.path)))
    .map((e) => ({ path: e.path, ...LOCKFILES.get(basename(e.path))!, sha: e.sha, size: e.size ?? 0 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---- workspace globs ----

/** `*` matches any run of characters in one segment. Backtracks only to the last `*`, so it stays O(n·m). */
function segmentMatches(pattern: string, segment: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < segment.length) {
    if (pattern[p] === '*') {
      star = p++;
      resume = s;
    } else if (p < pattern.length && pattern[p] === segment[s]) {
      p++;
      s++;
    } else if (star !== -1) {
      p = star + 1;
      s = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Whether a pattern's segments match a path's, where `**` matches any number of segments. O(pattern × path). */
function globMatches(pattern: string[], segments: string[]): boolean {
  // reached[j]: the pattern so far matches the first j segments.
  let reached = new Uint8Array(segments.length + 1);
  reached[0] = 1;
  for (const part of pattern) {
    const next = new Uint8Array(segments.length + 1);
    if (part === '**') {
      for (let j = 0, any = 0; j <= segments.length; j++) next[j] = any |= reached[j]!;
    } else {
      for (let j = 0; j < segments.length; j++) if (reached[j] && segmentMatches(part, segments[j]!)) next[j + 1] = 1;
    }
    reached = next;
  }
  return reached[segments.length] === 1;
}

const patternSegments = (pattern: string) => pattern.split('/').filter((s) => s !== '' && s !== '.');

/** The `package.json` files of the workspaces the patterns name, under `projectDir` and never in node_modules. */
export function workspacePackageJsonPaths(patterns: string[], treePaths: string[], projectDir: string): string[] {
  const include: string[][] = [];
  const exclude: string[][] = [];
  for (const pattern of new Set(patterns)) {
    if (pattern.startsWith('!')) exclude.push(patternSegments(pattern.slice(1)));
    else include.push(patternSegments(pattern));
  }
  const matches = (dir: string[]) => (pattern: string[]) => globMatches(pattern, dir);
  const found: string[] = [];
  for (const path of treePaths) {
    const rel = under(projectDir, path);
    if (rel === null || basename(rel) !== 'package.json') continue;
    const dir = rel.split('/').slice(0, -1);
    // The project's own package.json is the root, not a workspace.
    if (dir.length === 0 || dir.includes('node_modules')) continue;
    if (include.some(matches(dir)) && !exclude.some(matches(dir))) found.push(path);
  }
  return found.sort();
}

// ---- bundler detection ----

function configTool(name: string): string {
  if (name === '.parcelrc') return 'parcel';
  return name.startsWith('gatsby-config.') ? 'gatsby' : name.slice(0, name.indexOf('.'));
}

/**
 * The first bundler found in dependencies, then config files, then scripts, or null when there is none.
 * Only JS projects are asked: the scan gives Ruby projects null.
 */
export function detectJsBundler(packageJsons: PackageJson[], treePaths: string[], projectDir: string): string | null {
  for (const tool of BUNDLER_PACKAGES) {
    if (packageJsons.some((p) => DEPENDENCY_MAPS.some((key) => p[key].has(tool)))) return `${tool} (dependency)`;
  }
  const configs = treePaths.filter((path) => {
    if (!BUNDLER_CONFIG.test(basename(path))) return false;
    const rel = under(projectDir, path);
    return rel !== null && !rel.split('/').includes('node_modules');
  });
  if (configs.length > 0) {
    const name = basename(configs.sort()[0]!);
    return `${configTool(name)} (config file ${name})`;
  }
  for (const p of packageJsons) {
    for (const [name, script] of p.scripts) {
      const match = BUNDLER_SCRIPT.exec(script);
      if (match) return `${match[2] ?? 'ng'} (script "${name}")`;
    }
  }
  return null;
}

/** What the lockfile says its roots declare, so a bundler counts even when no package.json could be read. */
function declaredByLockfile(g: DepGraph): PackageJson {
  const dependencies = new Map<string, string>();
  for (const root of g.roots) {
    for (const e of root.edges) {
      const node = g.nodes[e.to];
      if (node) dependencies.set(node.name, node.version);
    }
  }
  const none = () => new Map<string, string>();
  return { name: null, dependencies, devDependencies: none(), optionalDependencies: none(), peerDependencies: none(), scripts: none(), workspaces: [] };
}

// ---- reading blobs ----

/** One repo's blobs, read one request at a time. */
class RepoFiles {
  readonly #client: GitHubClient;
  readonly #fullName: string;
  readonly #blobs: Map<string, TreeEntry>;
  readonly paths: string[];

  constructor(client: GitHubClient, fullName: string, tree: TreeEntry[]) {
    this.#client = client;
    this.#fullName = fullName;
    this.#blobs = new Map(tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]));
    this.paths = [...this.#blobs.keys()];
  }

  has(path: string): boolean {
    return this.#blobs.has(path);
  }

  /** A blob's text, or what to record when it can't be read. Anything but a GitHub API error is thrown. */
  async read(entry: { sha: string; size?: number }): Promise<{ text: string } | { error: string }> {
    const tooLarge = { error: 'The lockfile is larger than 20 MB.' };
    if ((entry.size ?? 0) > MAX_LOCKFILE_BYTES) return tooLarge;
    let blob: unknown;
    try {
      blob = await this.#client.getJson(`/repos/${this.#fullName}/git/blobs/${encodeURIComponent(entry.sha)}`);
    } catch (err) {
      if (!(err instanceof GitHubApiError)) throw err;
      return { error: err.message };
    }
    if (!isJsonObject(blob) || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      return { error: "Couldn't read this lockfile." };
    }
    const bytes = Buffer.from(blob.content.replace(/\s+/g, ''), 'base64');
    if (bytes.length > MAX_LOCKFILE_BYTES) return tooLarge;
    return { text: new TextDecoder().decode(bytes) };
  }

  /** A companion's text, or null when it's absent or can't be read. */
  async text(path: string): Promise<string | null> {
    const entry = this.#blobs.get(path);
    if (!entry) return null;
    const read = await this.read(entry);
    return 'text' in read ? read.text : null;
  }
}

/** One project's package.json files: at most MAX_PACKAGE_JSONS are read, each once. */
class PackageJsons {
  readonly #files: RepoFiles;
  readonly #read = new Map<string, PackageJson | null>();
  capped = false; // one more was needed past the limit
  unreadable = false; // one in the tree couldn't be fetched or parsed

  constructor(files: RepoFiles) {
    this.#files = files;
  }

  /** The package.json at `path`, or null when it's absent, unreadable, or past the limit. */
  async at(path: string): Promise<PackageJson | null> {
    if (this.#read.has(path)) return this.#read.get(path) ?? null;
    if (!this.#files.has(path)) return null;
    if (this.#read.size >= MAX_PACKAGE_JSONS) {
      this.capped = true;
      return null;
    }
    const text = await this.#files.text(path);
    const pkg = text === null ? null : readPackageJson(text);
    if (pkg === null) this.unreadable = true;
    this.#read.set(path, pkg);
    return pkg;
  }

  all(): PackageJson[] {
    return [...this.#read.values()].filter((p) => p !== null);
  }
}

// ---- scanning ----

async function scanRubyProject(files: RepoFiles, c: LockfileCandidate): Promise<ProjectScan> {
  const gemfile = await files.text(fileIn(dirname(c.path), 'Gemfile'));
  const lock = await files.read(c);
  const result = 'error' in lock ? failed(lock.error) : parseGemfileLock(lock.text, gemfile);
  return { path: c.path, ecosystem: c.ecosystem, blobSha: c.sha, result, jsBundler: null };
}

async function scanJsProject(files: RepoFiles, c: LockfileCandidate, truncated: boolean): Promise<ProjectScan> {
  const dir = dirname(c.path);
  const packageJsons = new PackageJsons(files);

  // Companions first: the project's package.json and, for yarn, its workspaces'.
  const root = await packageJsons.at(fileIn(dir, 'package.json'));
  const workspaces: { path: string; packageJson: PackageJson }[] = [];
  let unsupportedPattern = false;
  if (c.kind === 'yarn' && root) {
    const patterns = [...new Set(root.workspaces)];
    const tooMany = patterns.length > MAX_WORKSPACE_PATTERNS || patterns.some((p) => p.length > MAX_PATTERN_LENGTH);
    unsupportedPattern = tooMany || patterns.some((p) => UNSUPPORTED_GLOB.test(p));
    for (const path of tooMany ? [] : workspacePackageJsonPaths(patterns, files.paths, dir)) {
      const packageJson = await packageJsons.at(path);
      if (packageJson) workspaces.push({ path: under(dir, dirname(path))!, packageJson });
    }
  }

  const lock = await files.read(c);
  let result: ParseResult;
  if ('error' in lock) result = failed(lock.error);
  else if (c.kind === 'npm') result = parseNpmLock(lock.text, root);
  else if (c.kind === 'yarn') result = parseYarnLock(lock.text, root ? [{ path: '.', packageJson: root }, ...workspaces] : []);
  else result = parsePnpmLock(lock.text);

  // Then each graph root's package.json, for bundler detection only.
  const declared: PackageJson[] = [];
  if (result.status === 'ok') {
    for (const r of result.graph.roots) {
      const rootDir = resolvePath(dir, r.path);
      if (rootDir !== null) await packageJsons.at(fileIn(rootDir, 'package.json'));
    }
    declared.push(declaredByLockfile(result.graph));
  }

  let jsBundler: string | null;
  if (packageJsons.capped) jsBundler = `unknown (more than ${MAX_PACKAGE_JSONS} package.json files)`;
  else {
    jsBundler = detectJsBundler([...packageJsons.all(), ...declared], files.paths, dir);
    if (jsBundler === null && truncated) jsBundler = "unknown (the repo's file list was truncated)";
    if (jsBundler === null && packageJsons.unreadable) jsBundler = "unknown (a package.json couldn't be read)";
    if (jsBundler === null && unsupportedPattern) jsBundler = "unknown (a workspace pattern isn't supported)";
  }
  return { path: c.path, ecosystem: c.ecosystem, blobSha: c.sha, result, jsBundler };
}

/**
 * Reads every lockfile in the repo's default branch. A blob or parse failure is recorded for that lockfile only.
 * Requests run one at a time: the tree, then for each lockfile its companions, the lockfile, and its roots' package.json files.
 */
export async function scanRepoLockfiles(client: GitHubClient, fullName: string): Promise<RepoLockfileScan> {
  let tree: TreeJson;
  try {
    tree = await client.getJson<TreeJson>(`/repos/${fullName}/git/trees/HEAD?recursive=1`);
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    if (err.status === 409) return { status: 'empty', error: null, truncated: false, projects: [] };
    return { status: 'error', error: err.message, truncated: false, projects: [] };
  }
  const entries = tree.tree ?? [];
  const truncated = tree.truncated === true;
  const candidates = findLockfiles(entries);
  if (candidates.length === 0) return { status: 'none', error: null, truncated, projects: [] };

  const files = new RepoFiles(client, fullName, entries);
  const projects: ProjectScan[] = [];
  for (const c of candidates) {
    projects.push(c.kind === 'bundler' ? await scanRubyProject(files, c) : await scanJsProject(files, c, truncated));
  }
  return { status: 'ok', error: null, truncated, projects };
}
