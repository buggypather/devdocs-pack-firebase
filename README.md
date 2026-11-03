# DevDocs pack builder

Turns documentation written in Markdown, in any public GitHub repository, into a
[doc pack](https://github.com/buggypather/devdocs/blob/main-custom-docs/docs/doc-packs.md)
that you can add to DevDocs: searchable, readable offline, and updated every week.

It's set up for [GitHub Pages' documentation](https://docs.github.com/en/pages) as an example.

## Make your own pack

1. Click **Use this template** at the top of this page, and create your own copy.
2. In your copy, edit `pack.config.json` (pencil icon) to point at the docs you want; see below.
3. Commit. GitHub builds the pack in a minute or two: follow it on the **Actions** tab.
4. In DevDocs, open **Preferences**, paste `https://github.com/<you>/<your-copy>/tree/pack`
   under **Doc packs**, and click **Add**. Then tick the docs in the list on the left and save.

The pack is rebuilt every Monday, and whenever you change the config. To rebuild it now, open the
**Actions** tab, choose **Build doc pack**, and click **Run workflow**.

To let others find your pack, add the topic `devdocs-pack` to your repository (the gear next to
**About** on its page).

## Examples

- [devdocs-pack-firebase](https://github.com/buggypather/devdocs-pack-firebase): the Firebase
  JavaScript SDK's API reference, from the Markdown in
  [firebase/firebase-js-sdk](https://github.com/firebase/firebase-js-sdk/tree/main/docs-devsite).

## pack.config.json

```json
{
  "name": "GitHub Docs",
  "docs": [
    {
      "name": "GitHub Pages",
      "slug": "github_pages",
      "category": "services",
      "source": {
        "repo": "github/docs",
        "path": "content/pages",
        "root": "content"
      },
      "versions": ["fpt"],
      "site": "https://docs.github.com/en",
      "attribution": "&copy; GitHub, Inc.<br>Licensed under the Creative Commons Attribution 4.0 International License."
    }
  ]
}
```

| Setting | |
|---|---|
| `name` | The pack's name, shown in DevDocs' preferences. |
| `docs` | One entry per doc; a pack can hold several. |
| `name` (of a doc) | Shown in DevDocs' sidebar. |
| `slug` | The doc's short name in addresses: lower-case letters, digits, `_` and `.` only (no hyphens), e.g. `github_pages`. Add a version after `~`: `vue~3`. |
| `version` | Optional, e.g. `"3"`, shown after the name. |
| `category` | Optional: where DevDocs lists the doc. One of `languages`, `web`, `frameworks`, `libraries`, `testing`, `tools`, `databases`, `ai`, `services`, `other` (the default). |
| `source.repo` | The GitHub repository the docs are in, as `owner/name`. |
| `source.ref` | Optional: a branch or tag. The default branch otherwise. |
| `source.path` | The folder of the docs in the repository. Leave it out if the docs are the whole repository. |
| `source.root` | Optional: the folder that links starting with `/` are relative to. For GitHub's docs, `content`. Defaults to `path`. |
| `source.data` | Optional: the folder with the variables and snippets that `{% data ... %}` tags use. Defaults to `data`. |
| `source.toc` | Optional: a table of contents in the `_toc.yaml` form of Google's developer sites, in the docs' folder. It sets the pages' order, and each top item becomes a sidebar group. |
| `entries` | Optional: what's searchable besides each page. `sections` (the default) adds each `##` section; `api` is for API references made by [API Documenter](https://api-extractor.com/pages/setup/generating_docs/), and adds each function and member, e.g. `getAuth()` and `User.reload()`. |
| `versions` | For GitHub's docs: which product's content to keep where pages differ. `fpt` is GitHub.com (Free, Pro, Team); `ghec` Enterprise Cloud; `ghes` Enterprise Server. Defaults to `["fpt"]`. |
| `site` | Optional: where the docs are published. Links to pages outside the doc go there, and each page links to its original. |
| `attribution` | The docs' copyright and licence, shown at the bottom of each page. **Check that the licence allows sharing**, and say who wrote them. |
| `links` | Optional: `{"home": "...", "code": "..."}` for the doc's Homepage and Source code links. Made from `site` and `repo` otherwise. |

## What it understands

- Markdown (`.md`, `.markdown`, `.mdx`) with GitHub's extensions: tables, task lists, and
  alerts (`> [!NOTE]`), which become DevDocs notes.
- Front matter: `title`, `shortTitle` (used for sidebar groups) and `intro`, and the `children` list
  that orders a folder's pages. Pages without front matter take their title from their first `#` heading.
- The template tags of GitHub's docs and other Jekyll sites: `{% data %}` variables and snippets,
  `{% ifversion %}`, `{% raw %}` and icons.
- Headings with their own ids, `## Setup {#setup}` or `{:#setup}`, as Jekyll, Hugo and Google's sites write them.
- The settings lines (`Project:`, `Book:`) at the top of pages from Google's developer sites.
- Links between pages, which stay inside DevDocs; images, which load from GitHub.

Each page becomes a search entry, and so does each `##` section. Pages are grouped in the sidebar
by their top folder.

## Building on your own computer

Needs [Node.js](https://nodejs.org) 22 or newer and Git.

```sh
npm install
npm run build        # writes the pack to pack/
npm test
```

To try the result, serve `pack/` with any web server that sends `Access-Control-Allow-Origin: *`,
and add its `http://localhost:...` address in DevDocs.
