// Gets a doc's source: a folder on this computer, or a GitHub repository.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * @typedef {object} Source
 * @property {string} dir The repository's (or folder's) root on this computer.
 * @property {string | null} repo `owner/name` on GitHub, if it's from GitHub.
 * @property {string} ref The branch, tag or commit; `HEAD` for the default branch.
 * @property {string | null} commit The commit that was checked out.
 */

/**
 * Checks out the folders a doc needs from its repository, into the cache.
 * Only those folders are downloaded, and no history, so a large repository
 * (GitHub's docs are over a gigabyte) takes seconds.
 *
 * @param {{ repo?: string, ref?: string, dir?: string }} source From the config.
 * @param {string[] | null} folders Paths inside the repository, or `null`
 *   for all of it.
 * @param {{ cacheDir: string, baseDir: string, debug?: (message: string) => void }} options
 * @returns {Source}
 */
export function fetchSource(source, folders, { cacheDir, baseDir, debug = () => {} }) {
  /** @param {string[]} args */
  const git = (args) => {
    const started = Date.now();
    const output = runGit(args);
    debug(`git ${args.join(" ")} (${Date.now() - started} ms)`);
    return output;
  };

  if (source.dir) {
    debug(`Using the folder ${resolve(baseDir, source.dir)}`);
    return { dir: resolve(baseDir, source.dir), repo: source.repo || null, ref: source.ref || "HEAD", commit: null };
  }

  const repo = /** @type {string} */ (source.repo);
  const dir = join(cacheDir, repo.replace("/", "__"));
  const url = `https://github.com/${repo}.git`;

  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(cacheDir, { recursive: true });
    git(["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", ...(source.ref ? ["--branch", source.ref] : []), url, dir]);
  } else {
    git(["-C", dir, "fetch", "--depth", "1", "--filter=blob:none", "origin", source.ref || "HEAD"]);
    git(["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
  }
  if (folders) {
    git(["-C", dir, "sparse-checkout", "set", "--no-cone", ...folders.map((folder) => `/${folder}/`)]);
  } else {
    git(["-C", dir, "sparse-checkout", "disable"]);
  }
  git(["-C", dir, "checkout", "--force"]);

  const commit = git(["-C", dir, "rev-parse", "HEAD"]).trim();
  debug(`Checked out ${repo} at ${commit} into ${dir}`);
  return { dir, repo, ref: source.ref || "HEAD", commit };
}

/**
 * @param {string[]} args
 * @returns {string} What git printed.
 */
function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Couldn't run git (${result.error.message}). Is Git installed?`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout;
}
