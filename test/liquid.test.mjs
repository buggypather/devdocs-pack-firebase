import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderLiquid, versionMatches } from "../src/liquid.mjs";

const context = {
  dataDir: fileURLToPath(new URL("fixtures/repo/data", import.meta.url)),
  versions: new Set(["fpt"]),
};
const render = (text) => renderLiquid(text, context);

test("variables and reusables are filled in, including inside each other", () => {
  assert.equal(render("Use {% data variables.product.name %}."), "Use Widget.");
  assert.equal(render("{% data reusables.guide.tip %}"), "Tip: Widget saves your work.");
  assert.equal(render("{% data variables.product.missing %}|{% data reusables.none %}"), "|");
});

test("indented references indent every line", () => {
  assert.equal(render("{% indented_data_reference reusables.guide.tip spaces=3 %}"), "   Tip: Widget saves your work.");
});

test("only the content for the chosen version is kept", () => {
  const text = "{% ifversion ghes %}server{% elsif fpt %}cloud{% else %}other{% endif %}";
  assert.equal(render(text), "cloud");
  assert.equal(renderLiquid(text, { ...context, versions: new Set(["ghes"]) }), "server");
  assert.equal(renderLiquid(text, { ...context, versions: new Set(["ghae"]) }), "other");
  assert.equal(render("{% ifversion fpt %}a{% ifversion ghes %}b{% else %}c{% endif %}d{% endif %}"), "acd");
  assert.equal(render("{% ifversion ghes %}a{% ifversion fpt %}b{% endif %}c{% endif %}d"), "d");
});

test("conditions: or, and, not, version numbers and features", () => {
  assert.equal(versionMatches("fpt or ghec", context), true);
  assert.equal(versionMatches("ghes > 3.9", context), false);
  assert.equal(versionMatches("not ghes", context), true);
  assert.equal(versionMatches("fpt and not ghec", context), true);
  assert.equal(versionMatches("new-thing", context), true, "from data/features");
  assert.equal(versionMatches("unknown-feature", context), true, "shown when unknown");
});

test("a tag alone on its line takes the line with it", () => {
  // A blank line left behind would end the HTML block in Markdown.
  assert.equal(
    render("<table>\n<tr>1</tr>\n{% ifversion fpt %}\n<tr>2</tr>\n{%- else %}\n<tr>3</tr>\n{% endif %}\n</table>\n"),
    "<table>\n<tr>1</tr>\n<tr>2</tr>\n</table>\n",
  );
  assert.equal(render("Press {% octicon \"rocket\" aria-hidden=\"true\" %} now."), "Press now.");
  assert.equal(render("click **{% octicon \"browser\" aria-hidden=\"true\" %} Pages**"), "click **Pages**");
  // Tags that print something keep the line break after them.
  assert.equal(
    render("1. {% data variables.product.name %}\n{% data reusables.guide.tip %}\n1. Next"),
    "1. Widget\nTip: Widget saves your work.\n1. Next",
  );
});

test("icons become a symbol, or their label unless they're decoration", () => {
  // Tables use ✓ and ✗ as yes and no.
  assert.equal(render('| {% octicon "check" aria-label="Supported" %} | {% octicon "x" aria-label="Not supported" %} |'), "| ✓ | ✗ |");
  assert.equal(render('select the **{% octicon "kebab-horizontal" aria-label="More" %}** menu'), "select the **⋯** menu");
  assert.equal(render('the {% octicon "organization" aria-label="Organizations" %} tab'), "the Organizations tab");
  assert.equal(render('the {% octicon "repo" aria-hidden="true" aria-label="repo" %} tab'), "the tab");
});

test("raw blocks are kept as they are; comments and captures are dropped", () => {
  assert.equal(render("{% raw %}{% include x.html %}{% endraw %}"), "{% include x.html %}");
  assert.equal(render("a{% comment %}{% data variables.product.name %}{% endcomment %}b"), "ab");
  assert.equal(render("a{% capture x %}hidden{% endcapture %}b"), "ab");
  assert.equal(render("{{ page.title }}"), "{{ page.title }}");
});
