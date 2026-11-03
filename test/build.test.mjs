import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildPack, readConfig } from "../src/build.mjs";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

const config = {
  name: "Test pack",
  docs: [
    {
      name: "Widget",
      slug: "widget",
      category: "tools",
      source: { dir: "repo", repo: "owner/repo", path: "content/guide", root: "content" },
      site: "https://docs.example.com/en",
      attribution: "&copy; Example",
    },
  ],
};

const build = (outDir) =>
  buildPack(config, { outDir, baseDir: FIXTURES, cacheDir: join(outDir, ".cache") });

const read = (dir, file) => readFileSync(join(dir, file), "utf8");

test("a Markdown folder becomes a doc pack DevDocs can read", (t) => {
  const out = mkdtempSync(join(tmpdir(), "pack-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(out);

  const manifest = JSON.parse(read(out, "docs.json"));
  assert.equal(manifest.name, "Test pack");
  const [doc] = manifest.docs;
  assert.equal(doc.slug, "widget");
  assert.equal(doc.type, "simple");
  assert.equal(doc.category, "tools");
  assert.equal(doc.db_size, Buffer.byteLength(read(out, "widget/db.json")));
  assert.deepEqual(doc.links, { home: "https://docs.example.com/en", code: "https://github.com/owner/repo" });

  const pages = JSON.parse(read(out, "widget/db.json"));
  assert.deepEqual(Object.keys(pages).sort(), ["first", "index", "second", "sub-folder/my-page"]);
  assert.equal(read(out, "widget/first.html"), pages.first);

  const index = JSON.parse(read(out, "widget/index.json"));
  // In the order the guide's index lists them, then the rest.
  assert.deepEqual(
    index.entries.filter((entry) => !entry.path.includes("#")).map((entry) => entry.path),
    ["second", "first", "sub-folder/my-page"],
  );
  assert.deepEqual(
    index.entries.filter((entry) => entry.path.startsWith("first#")).map((entry) => entry.name),
    ["First steps: Setting up Widget", "First steps: Setting up Widget"],
  );
  assert.deepEqual(
    index.entries.filter((entry) => entry.path.startsWith("first#")).map((entry) => entry.path),
    ["first#setting-up-widget", "first#setting-up-widget-1"],
  );
  // Pages at the top, and in a folder without an index page, are grouped
  // under the doc's name.
  assert.deepEqual(index.types, [{ name: "Widget", slug: "widget", count: index.entries.length }]);

  // Every path is one DevDocs accepts (no spaces, quotes, brackets or "..").
  for (const entry of index.entries) {
    assert.match(entry.path, /^[^\s"'`<>\\]+$/);
    assert.ok(!entry.path.startsWith("/") && !entry.path.split(/[/#]/).includes(".."), entry.path);
  }
});

test("pages: titles, liquid, notes, links and images", (t) => {
  const out = mkdtempSync(join(tmpdir(), "pack-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  build(out);
  const pages = JSON.parse(read(out, "widget/db.json"));

  const home = pages.index;
  assert.match(home, /^<h1>Widget guide<\/h1>\n<p>Everything about Widget.<\/p>/);
  // A folder page without text lists its pages, with their intros.
  assert.match(home, /<li><a href="second">Second page<\/a><\/li>/);
  assert.match(home, /<li><a href="first">First steps<\/a>: Start here.<\/li>/);

  const first = pages.first;
  assert.match(first, /<h2 id="setting-up-widget">Setting up Widget<\/h2>/);
  assert.match(first, /Tip: Widget saves your work./);
  assert.match(first, /<strong>Warning:<\/strong> Back up first.<\/p>\n<p><strong>Note:<\/strong> Merged/);
  assert.match(first, /<a href="second#the-part">Second page<\/a>/, "AUTOTITLE, linked within the pack");
  assert.match(first, /<a href="https:\/\/docs.example.com\/en\/other\/page">the other doc<\/a>/);
  assert.match(first, /<img src="https:\/\/raw.githubusercontent.com\/owner\/repo\/HEAD\/content\/guide\/images\/diagram.png" alt="A diagram">/);
  assert.match(first, /<table>\n<tr><td>Always<\/td><\/tr>\n<tr><td>Cloud only<\/td><\/tr>\n<\/table>/);
  assert.doesNotMatch(first, /Server only|Hidden/);
  assert.match(first, /New thing is on./);
  assert.match(first, /<a href="https:\/\/docs.example.com\/en\/guide\/first" class="_attribution-link">/);

  const second = pages.second;
  assert.match(second, /^<h1>Second page<\/h1>\n<h2 id="the-part">/, "the first heading is the title");
  assert.match(second, /<pre data-language="js">const a = 1 &lt; 2;<\/pre>/);
  assert.match(second, /Literal {% include x.html %} stays./);
  assert.doesNotMatch(second, /Not shown/);
  assert.match(second, /<a href="first#setting-up-widget">the first page<\/a>/);
  assert.match(second, /<a href="https:\/\/example.com\/">the site<\/a>/);

  assert.match(pages["sub-folder/my-page"], /<a href="..\/index">the guide<\/a>/);
  assert.match(pages["sub-folder/my-page"], /<p>\s*Tip: Widget saves your work.<\/p>/);
  assert.match(pages["sub-folder/my-page"], /href="https:\/\/docs.example.com\/en\/guide\/sub%20folder\/my%20page"/);
});

test("rebuilding unchanged pages keeps their build time", (t) => {
  const out = mkdtempSync(join(tmpdir(), "pack-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const manifest = () => JSON.parse(read(out, "docs.json")).docs[0];

  build(out);
  const first = manifest();
  writeFileSync(join(out, "docs.json"), JSON.stringify({ docs: [{ ...first, mtime: 123 }] }));
  build(out);
  assert.equal(manifest().mtime, 123);
  assert.equal(manifest().db_hash, first.db_hash);
});

test("config mistakes are explained", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const check = (json, pattern) => {
    const file = join(dir, "pack.config.json");
    writeFileSync(file, typeof json === "string" ? json : JSON.stringify(json));
    assert.throws(() => readConfig(file), pattern);
  };
  const doc = { name: "A", slug: "a", source: { repo: "o/r" } };

  check("{", /isn't valid JSON/);
  check({ docs: [] }, /at least one doc/);
  check({ docs: [{ ...doc, name: "" }] }, /needs a "name"/);
  check({ docs: [{ ...doc, slug: "my-docs" }] }, /"slug" must be/);
  check({ docs: [{ ...doc, source: {} }] }, /needs a "repo"/);
  check({ docs: [{ ...doc, source: { repo: "https://github.com/o/r" } }] }, /owner\/name/);
  check({ docs: [{ ...doc, source: { repo: "o/r", path: "../x" } }] }, /inside the repository/);
  check({ docs: [doc, doc] }, /its own "slug"/);
  check({ docs: [{ ...doc, category: "stuff" }] }, /"category" must be one of/);
});

test("verbose output names each page and each link that leaves the doc", (t) => {
  const out = mkdtempSync(join(tmpdir(), "pack-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const lines = [];
  buildPack(config, { outDir: out, baseDir: FIXTURES, cacheDir: join(out, ".cache"), debug: (line) => lines.push(line) });

  assert.ok(lines.some((line) => /^Using the folder .*repo$/.test(line)), "where the source is");
  assert.ok(lines.includes('content/guide/first.md -> first: "First steps"'), lines.join("\n"));
  assert.ok(lines.some((line) => /^ {2}link \/\S+ isn't in this doc: to the site$/.test(line)), "a link to the site");
  assert.equal(lines.length, new Set(lines).size, "nothing is logged twice");
});

test("an API Documenter reference: its table of contents, functions and members", (t) => {
  const out = mkdtempSync(join(tmpdir(), "pack-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const reference = {
    name: "Reference",
    docs: [
      {
        name: "Firebase",
        slug: "firebase",
        entries: "api",
        source: { dir: "reference", repo: "owner/sdk", path: "docs", toc: "_toc.yaml" },
      },
    ],
  };
  buildPack(readConfig(writeConfig(out, reference)), { outDir: out, baseDir: FIXTURES, cacheDir: join(out, ".cache") });

  const index = JSON.parse(read(out, "firebase/index.json"));
  // Ordered and grouped as the table of contents says.
  assert.deepEqual(index.entries.map((entry) => [entry.name, entry.path, entry.type]), [
    ["@firebase/auth", "auth", "auth"],
    ["getAuth()", "auth#getauth_cf608e1", "auth"],
    ["User", "auth.user", "auth"],
    ["User.emailVerified", "auth.user#useremailverified", "auth"],
    ["User.getIdToken()", "auth.user#usergetidtoken", "auth"],
    ["User.reload()", "auth.user#userreload", "auth"],
    ["@firebase/app", "app", "app"],
  ]);
  assert.deepEqual(index.types.map((type) => [type.name, type.count]), [["auth", 6], ["app", 1]]);

  const pages = JSON.parse(read(out, "firebase/db.json"));
  // The site's settings and the comment aren't shown; the heading keeps its own id.
  assert.ok(!pages.index.includes("Project:"));
  assert.ok(!pages.index.includes("DO NOT EDIT"));
  assert.ok(pages.auth.includes('<h3 id="getauth_cf608e1">getAuth(app)</h3>'));
  assert.ok(pages.auth.includes('<a href="auth.user#userreload">User.reload()</a>'));
  // Links to the top of a page go to the page.
  assert.ok(pages.index.includes('<a href="auth">@firebase/auth</a> <a href="auth.user">User</a>'));
});

test("a missing table of contents is explained", (t) => {
  const out = mkdtempSync(join(tmpdir(), "pack-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const reference = {
    docs: [{ name: "Firebase", slug: "firebase", source: { dir: "reference", path: "docs", toc: "nope.yaml" } }],
  };
  assert.throws(
    () => buildPack(reference, { outDir: out, baseDir: FIXTURES, cacheDir: join(out, ".cache") }),
    /There's no table of contents at .*nope\.yaml\. Check "toc" in pack\.config\.json\./,
  );
  assert.throws(() => readConfig(writeConfig(out, { docs: [{ ...reference.docs[0], entries: "all" }] })), /"entries" must be one of sections, api/);
});

/** @param {string} dir @param {object} value */
function writeConfig(dir, value) {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}
