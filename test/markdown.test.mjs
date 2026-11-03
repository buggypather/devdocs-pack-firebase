import assert from "node:assert/strict";
import test from "node:test";

import { createSlugger, renderMarkdown, splitFrontMatter } from "../src/markdown.mjs";

const options = {
  resolveLink: (href) => `resolved:${href}`,
  resolveImage: (src) => `https://img/${src}`,
  titleOf: (href) => (href === "/known" ? "Known page" : undefined),
};
const render = (markdown) => renderMarkdown(markdown, options).html;

test("front matter is split off the page", () => {
  assert.deepEqual(splitFrontMatter("---\ntitle: Hi\n---\nBody"), { data: { title: "Hi" }, body: "Body" });
  assert.deepEqual(splitFrontMatter("No front matter"), { data: {}, body: "No front matter" });
  assert.deepEqual(splitFrontMatter("---\n: bad: yaml\n---\nBody").body, "Body");
});

test("headings get GitHub's ids, numbered when repeated", () => {
  const { html, headings } = renderMarkdown("## Hello, World!\n\n## Hello, World!\n\n### `code` & more", options);
  assert.match(html, /<h2 id="hello-world">Hello, World!<\/h2>/);
  assert.deepEqual(
    headings.map((h) => [h.id, h.depth]),
    [["hello-world", 2], ["hello-world-1", 2], ["code--more", 3]],
  );
  const slug = createSlugger();
  assert.equal(slug("Über café"), "über-café");
  assert.equal(slug("!!!"), "section");
});

test("code blocks are escaped and name their language for DevDocs", () => {
  assert.equal(render("```js title=x\nif (a < b) {}\n```"), '<pre data-language="js">if (a &lt; b) {}</pre>\n');
  assert.equal(render("```\nplain\n```"), "<pre>plain</pre>\n");
});

test("GitHub alerts become labelled notes, even two in one quote", () => {
  const html = render("> [!WARNING]\n> Careful.\n> [!TIP]\n> A tip.");
  assert.match(html, /<p><strong>Warning:<\/strong> Careful.<\/p>\n<p><strong>Tip:<\/strong> A tip.<\/p>/);
});

test("links are resolved, and AUTOTITLE shows the target's title", () => {
  assert.equal(render("[AUTOTITLE](/known)"), '<p><a href="resolved:/known">Known page</a></p>\n');
  // A page outside the doc is named after its address.
  assert.equal(render("[AUTOTITLE](/actions)"), '<p><a href="resolved:/actions">Actions</a></p>\n');
  assert.equal(
    render("[AUTOTITLE](/actions/using-workflows#syntax)"),
    '<p><a href="resolved:/actions/using-workflows#syntax">Using workflows</a></p>\n',
  );
});

test("images are resolved, in Markdown and in HTML", () => {
  assert.match(render("![Alt](a/b.png)"), /<img src="https:\/\/img\/a\/b.png" alt="Alt">/);
  assert.match(render('<img src="/x.png" alt="y">'), /src="https:\/\/img\/\/x.png"/);
});

test("a heading can give its own id, as Jekyll and Google's sites write it", () => {
  const { html, headings } = renderMarkdown("## getAuth(app) {:#getauth_cf608e1}\n\n## Setup {#setup .wide}\n\n## Plain", options);
  assert.ok(html.includes('<h2 id="getauth_cf608e1">getAuth(app)</h2>'));
  assert.ok(html.includes('<h2 id="setup">Setup</h2>'));
  assert.deepEqual(headings.map((h) => [h.id, h.text, h.explicit]), [
    ["getauth_cf608e1", "getAuth(app)", true],
    ["setup", "Setup", true],
    ["plain", "Plain", false],
  ]);
});
