// Markdown to the HTML DevDocs shows.

import { Marked } from "marked";
import { parse as parseYaml } from "yaml";

/**
 * @typedef {object} RenderOptions
 * @property {(href: string) => string} resolveLink Where a link should point.
 * @property {(src: string) => string} resolveImage Where an image is served from.
 * @property {(href: string) => string | undefined} titleOf The title of the
 *   page a link points to, for GitHub's `[AUTOTITLE](...)` links.
 */

/**
 * @typedef {object} Heading
 * @property {string} id
 * @property {string} text
 * @property {number} depth
 * @property {boolean} explicit Whether the page gave the id (`{#id}`).
 */

/** A heading's own id at its end, as Jekyll, Hugo and Google's sites write it: `{#id}` or `{:#id}`. */
const HEADING_ID_RGX = /\s*\{:?\s*#([\w.:-]+)[^}]*\}\s*$/;

const ALERTS = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/**
 * Splits a page into its YAML front matter and its body.
 *
 * @param {string} text
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function splitFrontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    return { data: {}, body: text };
  }
  let data;
  try {
    data = parseYaml(match[1]);
  } catch (error) {
    data = null;
  }
  return {
    data: data && typeof data === "object" ? data : {},
    body: text.slice(match[0].length),
  };
}

/**
 * @param {string} markdown
 * @param {RenderOptions} options
 * @returns {{ html: string, headings: Heading[] }}
 */
export function renderMarkdown(markdown, options) {
  /** @type {Heading[]} */
  const headings = [];
  const slugger = createSlugger();

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        let inner = this.parser.parseInline(tokens);
        const own = inner.match(HEADING_ID_RGX);
        if (own) inner = inner.slice(0, own.index);
        const text = textOf(inner);
        const id = own ? own[1] : slugger(text);
        headings.push({ id, text, depth, explicit: !!own });
        return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>\n`;
      },

      code({ text, lang }) {
        // DevDocs colours <pre data-language="..."> with Prism.
        const language = (lang || "").trim().split(/\s+/)[0];
        const attribute = language ? ` data-language="${escapeHtml(language)}"` : "";
        return `<pre${attribute}>${escapeHtml(text.replace(/\n$/, ""))}</pre>\n`;
      },

      link({ href, title, tokens }) {
        let inner = this.parser.parseInline(tokens);
        if (inner.trim() === "AUTOTITLE") {
          inner = escapeHtml(options.titleOf(href) || titleFromLink(href));
        }
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(options.resolveLink(href))}"${titleAttribute}>${inner}</a>`;
      },

      blockquote({ tokens }) {
        // GitHub's alerts (> [!NOTE]) become notes with a label. Two alerts in
        // a row merge into one quote, so a marker can also start a line.
        const label = (kind) => `<strong>${ALERTS[kind.toUpperCase()]}:</strong> `;
        const body = this.parser
          .parse(tokens)
          .replace(/^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, (_, kind) => `<p>${label(kind)}`)
          .replace(/\n\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/gi, (_, kind) => `</p>\n<p>${label(kind)}`);
        return `<blockquote>\n${body}</blockquote>\n`;
      },
    },
  });

  const html = /** @type {string} */ (marked.parse(markdown))
    // Images, including those written as HTML in the Markdown.
    .replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (_, start, src, end) =>
      start + escapeHtml(options.resolveImage(decodeHtml(src))) + end,
    );

  return { html, headings };
}

/**
 * Renders a line of Markdown (a page's intro) without a paragraph around it.
 *
 * @param {string} markdown
 * @param {RenderOptions} options
 * @returns {string}
 */
export function renderInline(markdown, options) {
  const { html } = renderMarkdown(markdown, options);
  return html.trim().replace(/^<p>([\s\S]*)<\/p>$/, "$1");
}

/**
 * A readable name for a link to a page outside the doc, from its address:
 * `/actions/using-workflows#x` is "Using workflows".
 *
 * @param {string} href
 */
function titleFromLink(href) {
  const name = href.split("#")[0].replace(/\/+$/, "").split("/").pop() || href;
  const words = decodeURIComponent(name).replace(/\.(md|mdx|html?)$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : href;
}

/**
 * Heading ids as GitHub makes them: lower case, punctuation dropped, spaces
 * as hyphens, and a number added to repeats.
 *
 * @returns {(text: string) => string}
 */
export function createSlugger() {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return (text) => {
    const base =
      text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

/**
 * The text of some HTML: tags removed, entities decoded.
 *
 * @param {string} html
 */
export function textOf(html) {
  return decodeHtml(html.replace(/<[^>]*>/g, "")).trim();
}

/** @param {string} text */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {string} html */
function decodeHtml(html) {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
