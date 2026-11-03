// Liquid template tags, as GitHub's docs (and other Jekyll-style sites) use them.
//
// Not a Liquid engine: just enough to turn the tags into the text a reader of
// the published site sees. Tags this doesn't know are dropped; `{{ ... }}`
// output tags are left alone, since in docs they're mostly literal examples
// (GitHub Actions' `${{ github.sha }}`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * @typedef {object} LiquidContext
 * @property {string | null} dataDir The repository's `data/` folder, holding
 *   `variables/*.yml`, `reusables/**.md` and `features/*.yml`, if it has one.
 * @property {Set<string>} versions The product versions to show, e.g. `fpt`
 *   (GitHub.com). Content for other versions is left out.
 */

/** GitHub's product versions; other names in `ifversion` are features. */
const PLANS = new Set(["fpt", "ghec", "ghes", "ghae"]);

/** A tag, with the spaces before it and the line break after it. */
const TAG_RGX = /([ \t]*)\{%-?\s*([\s\S]*?)\s*-?%\}([ \t]*\r?\n)?/g;

/**
 * Renders the Liquid tags in a page or a value.
 *
 * @param {string} text
 * @param {LiquidContext} context
 * @param {number} [depth] How deep in reusables this is, to stop loops.
 * @returns {string}
 */
export function renderLiquid(text, context, depth = 0) {
  if (depth > 10 || !text.includes("{%")) {
    return text;
  }

  let output = "";
  let last = 0;
  // One frame per open if: whether its content is shown, and whether a branch
  // of it has been taken yet.
  /** @type {{ showing: boolean, taken: boolean }[]} */
  const ifs = [];
  const showing = () => ifs.every((frame) => frame.showing);
  /** @type {string | null} The tag that ends the block being skipped. */
  let skipUntil = null;
  /** @type {number | null} Where the current raw block's text starts. */
  let rawStart = null;

  for (const match of text.matchAll(TAG_RGX)) {
    const [whole, indent, body, lineEnd] = match;
    const [name, ...rest] = body.split(/\s+/);
    const args = rest.join(" ");
    // A tag alone on its line takes the line with it, so no blank line is left
    // behind (which would end an HTML block in Markdown).
    const atLineStart = match.index === 0 || text[match.index - 1] === "\n";
    const standalone = atLineStart && lineEnd !== undefined;
    const before = text.slice(last, match.index) + (standalone ? "" : indent);
    last = match.index + whole.length;
    const after = standalone ? "" : lineEnd || "";

    if (rawStart !== null) {
      if (name === "endraw") {
        if (showing()) output += text.slice(rawStart, match.index);
        rawStart = null;
      }
      continue;
    }
    if (skipUntil) {
      if (name === skipUntil) skipUntil = null;
      continue;
    }

    if (showing()) output += before;

    switch (name) {
      case "raw":
        rawStart = last;
        break;
      case "comment":
      case "capture":
        skipUntil = `end${name}`;
        break;
      case "ifversion":
      case "if":
      case "unless": {
        const result = name === "ifversion" ? versionMatches(args, context) : true;
        const shown = name === "unless" ? !result : result;
        ifs.push({ showing: shown, taken: shown });
        break;
      }
      case "elsif": {
        const frame = ifs.at(-1);
        if (frame) {
          frame.showing = !frame.taken && versionMatches(args, context);
          frame.taken ||= frame.showing;
        }
        break;
      }
      case "else": {
        const frame = ifs.at(-1);
        if (frame) {
          frame.showing = !frame.taken;
          frame.taken = true;
        }
        break;
      }
      case "endif":
      case "endunless":
        ifs.pop();
        break;
      case "data":
      case "indented_data_reference": {
        if (!showing()) break;
        const [reference] = args.split(/\s+/);
        const spaces = Number(args.match(/spaces=(\d+)/)?.[1] || 0);
        const content = dataReference(reference, context, depth).replace(/^(?=.)/gm, " ".repeat(spaces));
        // Unlike the other tags, these print something, so a line of their
        // own keeps its indent and its line break.
        output += standalone ? indent + content + lineEnd : content;
        break;
      }
      case "octicon": {
        if (!showing()) break;
        const icon = octicon(args);
        output += icon;
        // A dropped icon before a word: **{% octicon "x" %} Pages** would
        // leave "** Pages**", which isn't bold any more.
        if (!icon && text[last] === " " && !/[\p{L}\p{N}]$/u.test(output)) last++;
        break;
      }
      default:
        // Anything else is dropped and the text around it stays: icons
        // (octicon), and blocks that pick a platform or tool ({% windows %},
        // {% cli %}), whose content all applies.
        break;
    }

    if (showing()) output += after;
  }

  if (showing()) output += text.slice(last);
  return output;
}

/** GitHub's icons that have a close enough symbol. */
const OCTICON_SYMBOLS = {
  check: "✓",
  x: "✗",
  "kebab-horizontal": "⋯",
  "kebab-vertical": "⋮",
  gear: "⚙",
  pencil: "✎",
  plus: "+",
  dash: "–",
  "triangle-down": "▾",
  "chevron-down": "▾",
  "link-external": "↗",
};

/**
 * The text standing for one of GitHub's icons: a symbol, or its label, or
 * nothing when it's only decoration (`aria-hidden="true"`).
 *
 * @param {string} args e.g. `"check" aria-label="Supported"`
 * @returns {string}
 */
function octicon(args) {
  const name = args.match(/^"([^"]+)"/)?.[1] || "";
  if (OCTICON_SYMBOLS[name]) return OCTICON_SYMBOLS[name];
  if (/aria-hidden="true"/.test(args)) return "";
  return args.match(/aria-label="([^"]+)"/)?.[1] || "";
}

/**
 * The value of `{% data variables.product.name %}` or the text of
 * `{% data reusables.pages.note %}`, itself rendered.
 *
 * @param {string} reference
 * @param {LiquidContext} context
 * @param {number} depth
 * @returns {string}
 */
function dataReference(reference, context, depth) {
  if (!context.dataDir || !/^[\w.-]+$/.test(reference)) {
    return "";
  }
  const [kind, ...keys] = reference.split(".");

  if (kind === "variables") {
    const [file, ...path] = keys;
    const data = readYaml(join(context.dataDir, "variables", `${file}.yml`));
    const value = path.reduce((object, key) => (object == null ? undefined : object[key]), data);
    return typeof value === "string" || typeof value === "number"
      ? renderLiquid(String(value), context, depth + 1)
      : "";
  }

  if (kind === "reusables") {
    const file = join(context.dataDir, "reusables", ...keys.slice(0, -1), `${keys.at(-1)}.md`);
    return existsSync(file)
      ? renderLiquid(readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trimEnd(), context, depth + 1)
      : "";
  }

  return "";
}

/**
 * Whether an `ifversion` condition holds for the chosen versions, e.g.
 * `fpt or ghec`, `ghes > 3.9`, `not ghes`, or a feature name, which
 * `data/features/<name>.yml` maps to versions.
 *
 * @param {string} condition
 * @param {LiquidContext} context
 * @returns {boolean}
 */
export function versionMatches(condition, context) {
  return condition.split(/\s+or\s+/).some((all) =>
    all.split(/\s+and\s+/).every((term) => {
      const negated = /^not\s+/.test(term);
      // Version comparisons (ghes > 3.9) only matter between releases of one
      // product, so only the product's name counts.
      const name = term.replace(/^not\s+/, "").trim().split(/\s+/)[0];
      const result = PLANS.has(name)
        ? context.versions.has(name)
        : featureMatches(name, context);
      return negated ? !result : result;
    }),
  );
}

/**
 * @param {string} name
 * @param {LiquidContext} context
 */
function featureMatches(name, context) {
  const file = context.dataDir && join(context.dataDir, "features", `${name}.yml`);
  const versions = file ? readYaml(file)?.versions : null;
  // An unknown name is shown: leaving content out is the worse mistake.
  return versions ? Object.keys(versions).some((plan) => context.versions.has(plan)) : true;
}

/** @type {Map<string, any>} */
const yamlCache = new Map();

/** @param {string} file */
function readYaml(file) {
  if (!yamlCache.has(file)) {
    yamlCache.set(file, existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : null);
  }
  return yamlCache.get(file);
}
