// package.json, read from any repo. Only the fields the lockfile parsers and bundler detection need,
// and only the file's own properties: a field named like an Object.prototype member is never inherited.

/** Maps, not objects, so names like `constructor` and `__proto__` are ordinary keys. */
export interface PackageJson {
  name: string | null;
  dependencies: Map<string, string>;
  devDependencies: Map<string, string>;
  optionalDependencies: Map<string, string>;
  peerDependencies: Map<string, string>;
  scripts: Map<string, string>;
  workspaces: string[]; // the array form or `workspaces.packages`
}

export type JsonObject = Record<string, unknown>;

export const isJsonObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The object's own value for `key`, or undefined. */
export const ownField = (o: JsonObject, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

// Anything but an object of strings reads as empty, and a non-string value is skipped.
function stringMap(v: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isJsonObject(v)) return map;
  for (const [key, value] of Object.entries(v)) if (typeof value === 'string') map.set(key, value);
  return map;
}

function workspacesOf(v: unknown): string[] {
  const list = isJsonObject(v) ? ownField(v, 'packages') : v;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

export function readPackageJson(text: string): PackageJson | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonObject(data)) return null;
  const name = ownField(data, 'name');
  return {
    name: typeof name === 'string' ? name : null,
    dependencies: stringMap(ownField(data, 'dependencies')),
    devDependencies: stringMap(ownField(data, 'devDependencies')),
    optionalDependencies: stringMap(ownField(data, 'optionalDependencies')),
    peerDependencies: stringMap(ownField(data, 'peerDependencies')),
    scripts: stringMap(ownField(data, 'scripts')),
    workspaces: workspacesOf(ownField(data, 'workspaces')),
  };
}
