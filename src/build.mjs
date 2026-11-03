// Builds a DevDocs doc pack from Markdown documentation.
//
// The pack is what DevDocs downloads when someone adds it under Preferences >
// Doc packs: docs.json listing the docs, and per doc a folder with
// index.json (search entries and sidebar groups), db.json (every page, for
// offline use) and each page as .html.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { renderLiquid } from "./liquid.mjs";
import { escapeHtml, renderInline, renderMarkdown, splitFrontMatter, textOf } from "./markdown.mjs";
import { fetchSource } from "./source.mjs";

/** The categories DevDocs groups docs in (its app/categories.js). */
export const CATEGORIES = ["languages", "web", "frameworks", "libraries", "testing", "tools", "databases", "ai", "services", "other"];

/** DevDocs' slug format: no hyphen (it starts a type in URLs) or slash. */
const SLUG_RGX = /^[a-z0-9_.]+(?:~[a-z0-9_.]+)?$/;
const MARKDOWN_RGX = /\.(md|markdown|mdx)$/i;
const ENTRY_KINDS = ["sections", "api"];
/** The settings at the top of a page on Google's developer sites, before a blank line. */
const DEVSITE_HEADER_RGX = /^(?:(?:Project|Book|page_type|description|keywords|robots)\s*:[^\n]*\n)+\n/i;
/** The kind API Documenter puts after a page's name: "User interface". */
const API_KIND_RGX = / (class|interface|namespace|enum|type|variable|function|package)$/i;
const API_TOP_RGX = /^#[\w.-]+_(package|class|interface|namespace|enum|typealias|variable|function)$/;

/**
 * @typedef {object} DocConfig
 * @property {string} name
 * @property {string} slug
 * @property {string} [version]
 * @property {{ repo?: string, ref?: string, dir?: string, path?: string, root?: string, data?: string, toc?: string }} source
 *   `path` is the documentation's folder in the repository; `root` the folder
 *   that links starting with "/" are relative to (GitHub's docs: `content`);
 *   `data` the folder of Liquid variables and reusables (`data`, if it exists);
 *   `toc` a table of contents in Google's `_toc.yaml` form, in `path`, that
 *   orders the pages and groups them in the sidebar.
 * @property {"sections" | "api"} [entries] What's searchable besides each
 *   page: its `##` sections (the default), or, for API references made by
 *   API Documenter, each function and member.
 * @property {string[]} [versions] For GitHub's docs: the versions to show.
 * @property {string} [site] The published documentation, e.g.
 *   `https://docs.github.com/en`, for links to pages outside the doc and the
 *   link to each page's original.
 * @property {string} [attribution] Copyright and licence, shown on each page.
 * @property {Record<string, string>} [links] `home` and `code` URLs.
 * @property {string} [category] Where DevDocs lists the doc: one of CATEGORIES.
 */

/**
 * @typedef {object} Page
 * @property {string} file Path in the repository, e.g. `content/pages/quickstart.md`.
 * @property {string} path Path in the pack, e.g. `quickstart`; `index` for the home page.
 * @property {boolean} isFolder Whether it's a folder's index page.
 * @property {Record<string, any>} data Front matter.
 * @property {string} body
 * @property {string} title
 * @property {string} shortTitle
 * @property {string} intro Markdown, with its Liquid rendered.
 */

/**
 * Reads and checks a pack config.
 *
 * @param {string} file
 * @returns {{ name?: string, docs: DocConfig[] }}
 */
export function readConfig(file) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} isn't valid JSON: ${error.message}`);
  }
  if (!config || !Array.isArray(config.docs) || config.docs.length === 0) {
    throw new Error(`${file} needs a "docs" list with at least one doc.`);
  }
  for (const [i, doc] of config.docs.entries()) {
    const where = `${file}, doc ${i + 1}`;
    if (!doc.name) throw new Error(`${where}: needs a "name".`);
    if (!SLUG_RGX.test(doc.slug || "")) {
      throw new Error(`${where}: "slug" must be lower-case letters, digits, "_" or ".", e.g. "github_pages", with an optional version after "~".`);
    }
    if (doc.category !== undefined && !CATEGORIES.includes(doc.category)) {
      throw new Error(`${where}: "category" must be one of ${CATEGORIES.join(", ")}.`);
    }
    if (!doc.source || (!doc.source.repo && !doc.source.dir)) {
      throw new Error(`${where}: "source" needs a "repo" (owner/name on GitHub) or a "dir".`);
    }
    if (doc.source.repo && !/^[\w.-]+\/[\w.-]+$/.test(doc.source.repo)) {
      throw new Error(`${where}: "repo" should look like "owner/name", e.g. "github/docs".`);
    }
    if (doc.entries !== undefined && !ENTRY_KINDS.includes(doc.entries)) {
      throw new Error(`${where}: "entries" must be one of ${ENTRY_KINDS.join(", ")}.`);
    }
    for (const key of ["path", "root", "data", "toc"]) {
      if (doc.source[key] && doc.source[key].split("/").includes("..")) {
        throw new Error(`${where}: "${key}" must be inside the repository.`);
      }
    }
  }
  if (new Set(config.docs.map((doc) => doc.slug)).size !== config.docs.length) {
    throw new Error(`${file}: each doc needs its own "slug".`);
  }
  return config;
}

/**
 * Builds every doc in the config into `outDir`.
 *
 * @param {{ name?: string, docs: DocConfig[] }} config
 * @param {{ outDir: string, baseDir: string, cacheDir: string, log?: (message: string) => void, debug?: (message: string) => void, repository?: string }} options
 */
export function buildPack(config, { outDir, baseDir, cacheDir, log = () => {}, debug = () => {}, repository }) {
  const previous = readPrevious(outDir);
  mkdirSync(outDir, { recursive: true });
  // Everything but the branch's own .git is rebuilt.
  for (const item of readdirSync(outDir)) {
    if (item !== ".git") rmSync(join(outDir, item), { recursive: true, force: true });
  }

  const docs = [];
  for (const doc of config.docs) {
    log(`${doc.name}: getting ${doc.source.repo || doc.source.dir}…`);
    // Only the doc's folder and the Liquid data are downloaded, unless the
    // doc is the whole repository.
    const docPath = clean(doc.source.path);
    const folders = docPath ? [docPath, clean(doc.source.data ?? "data")] : null;
    debug(`Folders to download: ${folders ? folders.join(", ") : "the whole repository"}`);
    const source = fetchSource(doc.source, folders, { cacheDir, baseDir, debug });
    const built = buildDoc(doc, source, debug);

    const docDir = join(outDir, doc.slug);
    for (const [path, html] of Object.entries(built.pages)) {
      const file = join(docDir, `${path}.html`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, html);
    }
    const db = JSON.stringify(built.pages);
    const hash = createHash("sha256").update(db).digest("hex").slice(0, 16);
    writeFileSync(join(docDir, "index.json"), JSON.stringify(built.index));
    writeFileSync(join(docDir, "db.json"), db);

    const before = previous.get(doc.slug);
    docs.push({
      name: doc.name,
      slug: doc.slug,
      type: "simple",
      ...(doc.version !== undefined && { version: String(doc.version) }),
      // Not "release", which DevDocs shows next to the doc's name.
      ...(source.commit && { source_commit: source.commit }),
      // Unchanged pages keep their build time, so DevDocs doesn't offer an
      // update that changes nothing.
      mtime: before?.db_hash === hash ? before.mtime : Math.floor(Date.now() / 1000),
      db_size: Buffer.byteLength(db),
      db_hash: hash,
      links: doc.links || defaultLinks(doc, source),
      ...(doc.attribution && { attribution: doc.attribution }),
      ...(doc.category && { category: doc.category }),
    });
    debug(`db.json is ${Buffer.byteLength(db)} bytes, hash ${hash}${before?.db_hash === hash ? " (unchanged, keeping its date)" : ""}`);
    log(`${doc.name}: ${Object.keys(built.pages).length} pages, ${built.index.entries.length} entries`);
  }

  writeFileSync(join(outDir, "docs.json"), JSON.stringify({ name: config.name, docs }, null, 2) + "\n");
  writeFileSync(join(outDir, "README.md"), packReadme(config, docs, repository));
  return docs;
}

/**
 * Turns one doc's Markdown into pages and an index.
 *
 * @param {DocConfig} doc
 * @param {import("./source.mjs").Source} source
 * @param {(message: string) => void} [debug] Told about each page and each link that leaves the doc.
 * @returns {{ pages: Record<string, string>, index: { entries: object[], types: object[] } }}
 */
export function buildDoc(doc, source, debug = () => {}) {
  const docPath = clean(doc.source.path);
  const root = clean(doc.source.root ?? doc.source.path);
  const dataDir = join(source.dir, clean(doc.source.data ?? "data"));
  const liquid = {
    dataDir: existsSync(dataDir) ? dataDir : null,
    versions: new Set(doc.versions || ["fpt"]),
  };
  const rawBase = source.repo
    ? `https://raw.githubusercontent.com/${source.repo}/${source.commit || source.ref}/`
    : null;

  const folder = join(source.dir, docPath);
  if (!existsSync(folder)) {
    throw new Error(`${doc.name}: there's no folder "${docPath || "."}" in ${source.repo || source.dir}.`);
  }

  // First pass: every page's title, so links can show the title they point to.
  /** @type {Page[]} */
  const pages = markdownFiles(folder).map((file) => readPage(file, docPath, source.dir, liquid, doc.name));
  if (!pages.some((page) => page.path === "index")) {
    pages.unshift({ file: posix.join(docPath, "index.md"), path: "index", isFolder: true, data: {}, body: "", title: doc.name, shortTitle: doc.name, intro: "" });
  }
  const byFile = new Map(pages.map((page) => [stripExtension(page.file), page]));
  const toc = doc.source.toc ? readToc(join(folder, clean(doc.source.toc)), pages, docPath) : null;
  if (toc) debug(`${toc.order.length} pages in the table of contents`);
  const ordered = [
    ...new Set([
      ...pages.filter((page) => page.path === "index"),
      ...(toc ? toc.order : []),
      ...orderPages(pages, docPath),
    ]),
  ];
  debug(`${pages.length} Markdown pages in ${docPath || "the repository"}${liquid.dataDir ? `; Liquid data from ${liquid.dataDir}` : "; no Liquid data folder"}`);

  /** @param {string} href */
  const findPage = (href, page) => {
    const [target] = href.split("#");
    if (!target || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) return null;
    const file = target.startsWith("/")
      ? posix.join(root, target)
      : posix.join(posix.dirname(page.file), target);
    const key = stripExtension(file.replace(/\/$/, ""));
    return byFile.get(key) || byFile.get(`${key}/index`) || byFile.get(key.replace(/\/index$/, "")) || null;
  };

  /** @type {Record<string, string>} */
  const html = {};
  const entries = [];
  const types = new Map();

  for (const page of ordered) {
    debug(`${page.file} -> ${page.path}: "${page.title}"`);
    const options = {
      resolveLink: (href) => {
        if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return href;
        const target = findPage(href, page);
        let hash = href.includes("#") ? href.slice(href.indexOf("#")) : "";
        // API Documenter names the top of a page "#userinfo_interface"; there's no such heading.
        if (doc.entries === "api" && API_TOP_RGX.test(hash)) hash = "";
        if (target) return relativeLink(page.path, target.path) + hash;
        if (href.startsWith("/") && doc.site) {
          debug(`  link ${href} isn't in this doc: to the site`);
          return doc.site.replace(/\/$/, "") + href;
        }
        if (source.repo) {
          // A file of the repository that isn't a page, e.g. an example.
          const file = posix.join(posix.dirname(page.file), href.split("#")[0]);
          debug(`  link ${href} isn't a page: to GitHub`);
          return `https://github.com/${source.repo}/blob/${source.ref}/${file}${hash}`;
        }
        debug(`  link ${href} isn't a page: left as it is`);
        return href;
      },
      resolveImage: (src) => {
        if (!rawBase || !src || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return src;
        const file = src.startsWith("/") ? src.slice(1) : posix.join(posix.dirname(page.file), src);
        return rawBase + file;
      },
      titleOf: (href) => findPage(href, page)?.title,
    };

    const { html: body, headings } = renderMarkdown(page.body, options);
    const intro = page.intro ? renderInline(page.intro, options) : "";
    const children = page.isFolder ? childList(page, ordered, options) : "";
    html[page.path] =
      `<h1>${escapeHtml(page.title)}</h1>\n` +
      (intro ? `<p>${intro}</p>\n` : "") +
      body +
      (children && !body.trim() ? children : "") +
      attribution(doc, page, root);

    if (page.path === "index") continue;
    const type = toc?.groups.get(page) || typeOf(page, pages, doc.name);
    /** @param {string} name @param {string} path */
    const addEntry = (name, path) => {
      entries.push({ name, path, type });
      types.set(type, (types.get(type) || 0) + 1);
    };
    if (doc.entries === "api") {
      // "User interface" is "User"; its members are "User.reload()", and a
      // package's functions have ids of their own: "getAuth(app) {:#getauth_cf608e1}".
      const name = page.title.replace(API_KIND_RGX, "");
      addEntry(name, page.path);
      for (const heading of headings) {
        if (heading.depth <= 4 && (heading.explicit || heading.text.startsWith(`${name}.`))) {
          addEntry(heading.text.replace(/([\w$])\(.*\)$/, "$1()"), `${page.path}#${heading.id}`);
        }
      }
    } else {
      addEntry(page.title, page.path);
      for (const heading of headings.filter((h) => h.depth === 2)) {
        addEntry(`${page.title}: ${heading.text}`, `${page.path}#${heading.id}`);
      }
    }
  }

  return {
    pages: html,
    index: {
      entries,
      types: [...types].map(([name, count]) => ({ name, slug: typeSlug(name), count })),
    },
  };
}

/**
 * @param {string} file Absolute path.
 * @param {string} docPath The doc's folder in the repository.
 * @param {string} repoDir
 * @param {import("./liquid.mjs").LiquidContext} liquid
 * @param {string} docName
 * @returns {Page}
 */
function readPage(file, docPath, repoDir, liquid, docName) {
  const repoFile = posix.normalize(file.slice(repoDir.length + 1).split("\\").join("/"));
  const inDoc = docPath ? repoFile.slice(docPath.length + 1) : repoFile;
  const name = stripExtension(inDoc);
  const isIndex = /(^|\/)(index|readme)$/i.test(name);
  const path =
    (isIndex ? name.replace(/\/?(index|readme)$/i, "") : name)
      // DevDocs drops entries whose path has spaces, quotes or brackets.
      .split("/")
      .map((segment) => segment.replace(/[^\w.~-]+/g, "-"))
      .join("/") || "index";

  // Windows line endings would throw off the line-based handling of tags.
  let { data, body } = splitFrontMatter(readFileSync(file, "utf8").replace(/\r\n?/g, "\n"));
  body = body.replace(DEVSITE_HEADER_RGX, "");
  // MDX: imports and exports aren't content.
  if (/\.mdx$/i.test(file)) body = body.replace(/^(import|export)\s.*$/gm, "");
  body = renderLiquid(body, liquid);

  let title = data.title ? textOf(renderLiquid(String(data.title), liquid)) : "";
  if (!title) {
    // A page without front matter takes its title from its first heading.
    const heading = body.match(/^#[ \t]+(.+?)[ \t#]*$/m);
    if (heading) {
      title = textOf(heading[1].replace(/[*_`]/g, ""));
      body = body.replace(heading[0], "");
    }
  }
  if (!title) {
    title = path === "index" ? docName : titleCase(posix.basename(path));
  }
  const shortTitle = data.shortTitle ? textOf(renderLiquid(String(data.shortTitle), liquid)) : title;

  const intro = data.intro ? renderLiquid(String(data.intro), liquid) : "";

  return { file: repoFile, path, isFolder: isIndex, data, body, title, shortTitle, intro };
}

/**
 * Reads a table of contents in the form of Google's developer sites
 * (`toc: [{ title, path, section: [...] }]`): its order, and each page's
 * group, the title of the top item it's under.
 *
 * @param {string} file Absolute path.
 * @param {Page[]} pages
 * @param {string} docPath
 * @returns {{ order: Page[], groups: Map<Page, string> }}
 */
function readToc(file, pages, docPath) {
  let data;
  try {
    data = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      error.code === "ENOENT"
        ? `There's no table of contents at ${file}. Check "toc" in pack.config.json.`
        : `The table of contents ${file} isn't valid YAML: ${error.message}`,
    );
  }
  const items = Array.isArray(data?.toc) ? data.toc : Array.isArray(data) ? data : [];
  const byName = new Map(pages.map((page) => [stripExtension(docPath ? page.file.slice(docPath.length + 1) : page.file), page]));
  // Its paths are the site's ("/docs/reference/js/auth.user.md"): the end that names a page counts.
  const find = (path) => {
    const segments = stripExtension(clean(String(path))).split("/");
    for (let i = 0; i < segments.length; i++) {
      const page = byName.get(segments.slice(i).join("/"));
      if (page) return page;
    }
    return null;
  };

  /** @type {Page[]} */
  const order = [];
  /** @type {Map<Page, string>} */
  const groups = new Map();
  const walk = (item, group) => {
    if (!item || typeof item !== "object") return;
    const page = item.path ? find(item.path) : null;
    if (page && !groups.has(page)) {
      groups.set(page, group);
      order.push(page);
    }
    for (const child of Array.isArray(item.section) ? item.section : []) walk(child, group);
  };
  for (const item of items) walk(item, String(item?.title ?? "").trim());
  return { order, groups };
}

/**
 * Pages in reading order: following the `children` lists of the index pages
 * (as GitHub's docs give them), then the rest by path.
 *
 * @param {Page[]} pages
 * @param {string} docPath
 * @returns {Page[]}
 */
function orderPages(pages, docPath) {
  const byPath = new Map(pages.map((page) => [page.path, page]));
  /** @type {Page[]} */
  const ordered = [];
  const seen = new Set();

  /** @param {Page | undefined} page */
  const visit = (page) => {
    if (!page || seen.has(page)) return;
    seen.add(page);
    ordered.push(page);
    if (!page.isFolder || !Array.isArray(page.data.children)) return;
    const folder = page.path === "index" ? "" : page.path;
    for (const child of page.data.children) {
      const path = posix.join(folder, String(child).replace(/^\//, ""));
      visit(byPath.get(path));
    }
  };

  visit(byPath.get("index"));
  for (const page of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    visit(page);
  }
  return ordered;
}

/**
 * The sidebar group of a page: its top folder's short title, or the doc's
 * name for pages at the top.
 *
 * @param {Page} page
 * @param {Page[]} pages
 * @param {string} docName
 */
function typeOf(page, pages, docName) {
  const [top] = page.path.split("/");
  const folder = pages.find((other) => other.isFolder && other.path === top);
  return folder ? folder.shortTitle : docName;
}

/**
 * A list of a folder page's pages, for index pages without text of their own.
 *
 * @param {Page} page
 * @param {Page[]} ordered
 * @param {import("./markdown.mjs").RenderOptions} options
 */
function childList(page, ordered, options) {
  const folder = page.path === "index" ? "" : `${page.path}/`;
  const children = ordered.filter(
    (other) => other !== page && other.path.startsWith(folder) && !other.path.slice(folder.length).includes("/"),
  );
  if (!children.length) return "";
  const items = children.map((child) => {
    const intro = child.intro ? renderInline(child.intro, options) : "";
    return `<li><a href="${escapeHtml(relativeLink(page.path, child.path))}">${escapeHtml(child.title)}</a>${intro ? `: ${intro}` : ""}</li>`;
  });
  return `<ul>\n${items.join("\n")}\n</ul>\n`;
}

/**
 * The copyright notice and a link to the page's original, as DevDocs' own
 * docs have at the bottom of each page.
 *
 * @param {DocConfig} doc
 * @param {Page} page
 * @param {string} root
 */
function attribution(doc, page, root) {
  if (!doc.attribution && !doc.site) return "";
  let urlPath = stripExtension(page.file).replace(/\/(index|readme)$/i, "");
  if (root && (urlPath === root || urlPath.startsWith(`${root}/`))) urlPath = urlPath.slice(root.length);
  const original = doc.site ? doc.site.replace(/\/$/, "") + encodeURI(urlPath.replace(/^\/?/, "/")) : "";
  return (
    `<div class="_attribution">\n  <p class="_attribution-p">\n    ${doc.attribution || ""}` +
    (original ? `${doc.attribution ? "<br>\n    " : ""}<a href="${escapeHtml(original)}" class="_attribution-link">${escapeHtml(original)}</a>` : "") +
    `\n  </p>\n</div>\n`
  );
}

/**
 * A link from one pack page to another, relative so it works wherever DevDocs
 * puts the doc. DevDocs shows page `a/b` at `/<doc>/a/b`.
 *
 * @param {string} from
 * @param {string} to
 */
function relativeLink(from, to) {
  const fromDir = from.includes("/") ? posix.dirname(from) : ".";
  return posix.relative(fromDir, to) || posix.basename(to);
}

/** @param {string} dir */
function markdownFiles(dir) {
  const files = [];
  for (const item of readdirSync(dir)) {
    if (item.startsWith(".") || item.startsWith("_") || item === "node_modules") continue;
    const path = join(dir, item);
    if (statSync(path).isDirectory()) files.push(...markdownFiles(path));
    else if (MARKDOWN_RGX.test(item)) files.push(path);
  }
  return files;
}

/** @param {string} outDir */
function readPrevious(outDir) {
  try {
    const json = JSON.parse(readFileSync(join(outDir, "docs.json"), "utf8"));
    return new Map((json.docs || []).map((doc) => [doc.slug, doc]));
  } catch (error) {
    return new Map();
  }
}

/**
 * @param {DocConfig} doc
 * @param {import("./source.mjs").Source} source
 */
function defaultLinks(doc, source) {
  const links = {};
  if (doc.site) links.home = doc.site;
  if (source.repo) links.code = `https://github.com/${source.repo}`;
  return Object.keys(links).length ? links : undefined;
}

/**
 * @param {{ name?: string }} config
 * @param {{ name: string }[]} docs
 * @param {string} [repository] `owner/name`, when built by GitHub Actions.
 */
function packReadme(config, docs, repository) {
  const address = repository ? `https://github.com/${repository}/tree/pack` : "this branch's address on GitHub";
  return `# ${config.name || "Doc pack"}

A [DevDocs](https://devdocs.io) doc pack, built automatically: don't edit this branch.

Docs: ${docs.map((doc) => doc.name).join(", ")}.

To use it, open DevDocs' **Preferences**, paste ${repository ? `\`${address}\`` : address} under **Doc packs**, and press **Add**.
`;
}

/** @param {string} name */
function typeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pages";
}

/** @param {string} name */
function titleCase(name) {
  return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** @param {string} file */
function stripExtension(file) {
  return file.replace(MARKDOWN_RGX, "");
}

/** @param {string | undefined} path */
function clean(path) {
  return (path || "").replace(/^\/+|\/+$/g, "");
}
