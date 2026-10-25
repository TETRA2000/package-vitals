import { describe, it, expect } from "vitest";
import {
  parseGemfileGroups,
  parseGemfileLock,
} from "../../../src/core/lockfiles/bundler.js";
import {
  devOnly,
  isComplete,
  type DepGraph,
  type ParseResult,
} from "../../../src/core/lockfiles/graph.js";

/** The graph of an `ok` result, checked against the shape every parser keeps. */
function graphOf(r: ParseResult): DepGraph {
  if (r.status !== "ok")
    throw new Error(`expected ok, got ${r.status}: ${r.message}`);
  const g = r.graph;
  expect(g.edges).toHaveLength(g.nodes.length);
  g.nodes.forEach((n, i) => expect(n.id).toBe(i));
  for (const e of [...g.roots.flatMap((x) => x.edges), ...g.edges.flat()]) {
    expect(Number.isInteger(e.to) && e.to >= 0 && e.to < g.nodes.length).toBe(
      true,
    );
  }
  return g;
}

const idOf = (g: DepGraph, name: string) => {
  const id = g.nodes.findIndex((n) => n.name === name);
  if (id < 0) throw new Error(`no node ${name}`);
  return id;
};

const LOCK = `GIT
  remote: https://github.com/acme/forked.git
  revision: abc123
  specs:
    forked (0.2.0)
      rack

PATH
  remote: .
  specs:
    local_gem (0.1.0)

GEM
  remote: https://rubygems.org/
  specs:
    rack (3.0.8)
    rails (7.0.0)
      rack (>= 2.0)
    pry (0.14.2)
      coderay (~> 1.1)
    coderay (1.1.3)

PLATFORMS
  ruby

DEPENDENCIES
  forked!
  local_gem!
  pry
  rails (~> 7.0)

BUNDLED WITH
   2.4.10
`;

describe("parseGemfileLock", () => {
  it("reads GEM, GIT, and PATH specs and the direct gems", () => {
    const g = graphOf(parseGemfileLock(LOCK, null));
    expect(g.format).toBe("bundler");
    expect(g.nodes.map((n) => `${n.name}@${n.version}`)).toEqual([
      "forked@0.2.0",
      "local_gem@0.1.0",
      "rack@3.0.8",
      "rails@7.0.0",
      "pry@0.14.2",
      "coderay@1.1.3",
    ]);
    expect(g.roots).toHaveLength(1);
    expect(g.roots[0]!.label).toBe(".");
    expect(g.roots[0]!.path).toBe(".");
    expect(g.roots[0]!.edges.map((e) => g.nodes[e.to]!.name)).toEqual([
      "forked",
      "local_gem",
      "pry",
      "rails",
    ]);
    expect(g.edges[idOf(g, "rails")]!.map((e) => g.nodes[e.to]!.name)).toEqual([
      "rack",
    ]);
    expect(g.edges[idOf(g, "forked")]!.map((e) => g.nodes[e.to]!.name)).toEqual(
      ["rack"],
    );
    expect(g.nodes.every((n) => n.lockDev === null)).toBe(true);
    expect(g.unresolved).toEqual([]);
  });

  it("makes gems dev from the Gemfile's groups", () => {
    const gemfile = `source 'https://rubygems.org'
gem 'rails'
gem 'forked', git: 'x'
gem 'local_gem', path: '.'
gem 'pry', group: :development
`;
    const g = graphOf(parseGemfileLock(LOCK, gemfile));
    expect(g.devKnown).toBe(true);
    const kind = (name: string) =>
      g.roots[0]!.edges.find((e) => g.nodes[e.to]!.name === name)!.kind;
    expect(kind("pry")).toBe("dev");
    expect(kind("rails")).toBe("prod");
    expect(devOnly(g, [idOf(g, "coderay")])).toBe(true);
    expect(devOnly(g, [idOf(g, "rack")])).toBe(false);
  });

  it("strips platforms and ignores CHECKSUMS", () => {
    const g = graphOf(
      parseGemfileLock(
        `GEM
  remote: https://rubygems.org/
  specs:
    nokogiri (1.15.4-arm64-darwin)
      racc (~> 1.4)
    nokogiri (1.15.4-x86_64-linux)
      racc (~> 1.4)
    racc (1.7.1)

DEPENDENCIES
  nokogiri

CHECKSUMS
  nokogiri (1.15.4-arm64-darwin) sha256=abc
  racc (1.7.1) sha256=def
`,
        null,
      ),
    );
    expect(g.nodes.map((n) => `${n.name}@${n.version}`)).toEqual([
      "nokogiri@1.15.4",
      "racc@1.7.1",
    ]);
    expect(g.edges[0]).toHaveLength(1);
    expect(g.unresolved).toEqual([]);
  });

  it("leaves groups unknown without a readable Gemfile", () => {
    for (const gemfile of [null, "group :test do\ngem 'pry'\n"]) {
      const g = graphOf(parseGemfileLock(LOCK, gemfile));
      expect(g.devKnown).toBe(false);
      expect(isComplete(g)).toBe(false);
      expect(devOnly(g, [idOf(g, "coderay")])).toBeNull();
      expect(g.roots[0]!.edges.every((e) => e.kind === "prod")).toBe(true);
    }
  });

  it("treats gemspec gems and gems missing from the Gemfile as runtime", () => {
    const g = graphOf(
      parseGemfileLock(LOCK, "gemspec\ngem 'pry', group: :test\n"),
    );
    const kind = (name: string) =>
      g.roots[0]!.edges.find((e) => g.nodes[e.to]!.name === name)!.kind;
    expect(kind("pry")).toBe("dev");
    expect(kind("rails")).toBe("prod");
    expect(kind("local_gem")).toBe("prod");
  });

  it("marks only rubygems.org gems as registry gems", () => {
    const g = graphOf(parseGemfileLock(LOCK, null));
    const reg = (name: string) => g.nodes[idOf(g, name)]!.registry;
    expect(reg("rack")).toBe(true);
    expect(reg("forked")).toBe(false);
    expect(reg("local_gem")).toBe(false);
    const other = graphOf(
      parseGemfileLock(
        "GEM\n  remote: https://gems.example.com/\n  specs:\n    a (1.0)\n\nDEPENDENCIES\n  a\n",
        null,
      ),
    );
    expect(other.nodes[0]!.registry).toBe(false);
  });

  it("reports an unresolved dependency, never a dangling edge", () => {
    const g = graphOf(
      parseGemfileLock(
        "GEM\n  remote: https://rubygems.org/\n  specs:\n    a (1.0)\n      constructor (>= 1)\n\nDEPENDENCIES\n  a\n  missing\n",
        null,
      ),
    );
    expect(g.unresolved).toEqual(["a > constructor", ". > missing"]);
    expect(isComplete(g)).toBe(false);
  });

  it("handles a BOM and CRLF in both files", () => {
    const g = graphOf(
      parseGemfileLock(
        "﻿" + LOCK.replace(/\n/g, "\r\n"),
        "﻿gem 'pry', group: :test\r\n",
      ),
    );
    expect(g.devKnown).toBe(true);
    expect(g.roots[0]!.edges.find((e) => g.nodes[e.to]!.name === "pry")!.kind).toBe(
      "dev",
    );
  });

  it("reports broken lockfiles with fixed messages", () => {
    expect(parseGemfileLock("<<<<<<< HEAD\nGEM\n", null)).toEqual({
      status: "error",
      message: "The lockfile has merge conflict markers.",
    });
    expect(
      parseGemfileLock("GEM\n  specs:\n    a (1.0)\n", null),
    ).toEqual({ status: "error", message: "Not a Gemfile.lock file." });
    expect(parseGemfileLock("", null)).toEqual({
      status: "error",
      message: "Not a Gemfile.lock file.",
    });
  });
});

describe("parseGemfileGroups", () => {
  it("reads group blocks, options, and string or symbol names", () => {
    const m = parseGemfileGroups(`
source 'https://rubygems.org'
gem 'rails'
group :development, :test do
  gem 'rspec' # a comment
  gem "factory"
end
gem 'pry', group: :development
gem 'x', groups: ["test"]
gem 'y', :group => :test
gem 'z', :groups => [:development, 'test']
group :production do
  gem 'pg'
end
`)!;
    expect(m.get("rails")).toEqual([]);
    expect(m.get("rspec")).toEqual(["development", "test"]);
    expect(m.get("factory")).toEqual(["development", "test"]);
    expect(m.get("pry")).toEqual(["development"]);
    expect(m.get("x")).toEqual(["test"]);
    expect(m.get("y")).toEqual(["test"]);
    expect(m.get("z")).toEqual(["development", "test"]);
    expect(m.get("pg")).toEqual(["production"]);
  });

  it("adds a block's groups to a gem's own, and only group blocks add groups", () => {
    const m = parseGemfileGroups(`
group :test do
  gem 'a', group: :production
  platforms :ruby do
    gem 'b'
  end
end
platforms :jruby do
  gem 'c'
end
if ENV['X']
  gem 'd'
end
gem 'e' if ENV['Y']
gem 'f'
`)!;
    expect(m.get("a")).toEqual(["test", "production"]);
    expect(m.get("b")).toEqual(["test"]);
    expect(m.get("c")).toEqual([]);
    expect(m.get("d")).toEqual([]);
    expect(m.get("e")).toEqual([]);
    expect(m.get("f")).toEqual([]);
  });

  it("merges repeated declarations: default wins, else the union", () => {
    const m = parseGemfileGroups(`
gem 'a', group: :test
gem 'a'
gem 'b', group: :test
group :development do
  gem 'b'
end
`)!;
    expect(m.get("a")).toEqual([]);
    expect(m.get("b")).toEqual(["test", "development"]);
  });

  it("does not read a # inside a string as a comment, or an option inside a string as an option", () => {
    const m = parseGemfileGroups(`
gem 'a', git: 'https://x/y#z', group: :test
gem 'b', require: 'group: :test'
gem 'c', require: 'a#b' # group: :test
`)!;
    expect(m.get("a")).toEqual(["test"]);
    expect(m.get("b")).toEqual([]);
    expect(m.get("c")).toEqual([]);
  });

  it("reads options on a continued line", () => {
    const m = parseGemfileGroups("gem 'a',\n  group: :test\n")!;
    expect(m.get("a")).toEqual(["test"]);
  });

  it("treats a group it can't read as runtime", () => {
    const m = parseGemfileGroups(
      "gem 'a', group: GROUP\ngroup GROUP do\n  gem 'b'\nend\n",
    )!;
    expect(m.get("a")).not.toEqual([]);
    expect(m.get("a")!.every((g) => g === "test" || g === "development")).toBe(
      false,
    );
    expect(m.get("b")!.every((g) => g === "test" || g === "development")).toBe(
      false,
    );
  });

  it("returns null when blocks don't balance", () => {
    expect(parseGemfileGroups("group :test do\ngem 'a'\n")).toBeNull();
    expect(parseGemfileGroups("gem 'a'\nend\n")).toBeNull();
  });

  it("handles gem names like constructor and a BOM", () => {
    const m = parseGemfileGroups("﻿gem 'constructor', group: :test\r\n")!;
    expect(m.get("constructor")).toEqual(["test"]);
    expect(m.get("toString")).toBeUndefined();
  });

  it("keeps other block forms balanced", () => {
    const m = parseGemfileGroups(`
source 'https://x' do
  gem 'a'
end
git 'https://y' do
  gem 'b'
end
install_if -> { RUBY_PLATFORM =~ /darwin/ } do
  gem 'c'
end
group :test do
  unless ENV['Z']
    gem 'd'
  end
end
`)!;
    expect(m.get("a")).toEqual([]);
    expect(m.get("b")).toEqual([]);
    expect(m.get("c")).toEqual([]);
    expect(m.get("d")).toEqual(["test"]);
  });
});

describe("Gemfile rules the lock parser relies on", () => {
  it("keeps a custom group such as production as runtime", () => {
    const g = graphOf(
      parseGemfileLock(
        LOCK,
        "gem 'pry', group: :production\ngroup :production do\n  gem 'rails'\nend\n",
      ),
    );
    expect(g.roots[0]!.edges.every((e) => e.kind === "prod")).toBe(true);
  });

  it("doesn't let a modifier if or unless open a block", () => {
    const m = parseGemfileGroups(
      "ruby '3.2.0' if RUBY_VERSION\nputs 'x' unless ENV['Q']\ngem 'a' if ENV['Y']\ngem 'b' unless ENV['Z']\n",
    );
    expect(m).not.toBeNull();
    expect(m!.get("a")).toEqual([]);
    expect(m!.get("b")).toEqual([]);
  });
});

describe("dev-group rule and input limits", () => {
  it("makes a gem dev only when every one of its groups is development or test", () => {
    for (const gemfile of [
      "gem 'pry', groups: [:development, :production]\n",
      "group :test do\n  gem 'pry', group: :production\nend\n",
      "group :test do\n  group :production do\n    gem 'pry'\n  end\nend\n",
      "gem 'pry', group: :test\ngem 'pry'\n",
    ]) {
      const g = graphOf(parseGemfileLock(LOCK, gemfile));
      const edge = g.roots[0]!.edges.find((e) => g.nodes[e.to]!.name === "pry")!;
      expect(edge.kind).toBe("prod");
      expect(devOnly(g, [idOf(g, "coderay")])).toBe(false);
    }
  });

  it("gives up on absurdly nested Gemfiles quickly", () => {
    const n = 8000;
    let text = "group :development do\n".repeat(n);
    for (let i = 0; i < n; i++) text += `gem 'g${i}'\n`;
    text += "end\n".repeat(n);
    const t = Date.now();
    expect(parseGemfileGroups(text)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("reads a spec with 80,000 dependency lines in linear time", () => {
    let lock = "GEM\n  remote: https://rubygems.org/\n  specs:\n    a (1.0)\n";
    for (let i = 0; i < 80_000; i++) lock += `      d${i}\n`;
    lock += "\nDEPENDENCIES\n  a\n";
    const t = Date.now();
    const r = parseGemfileLock(lock, null);
    expect(r.status).toBe("ok");
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
