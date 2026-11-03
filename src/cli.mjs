// Builds the doc pack described by a config file.
//
//   npm run build                          pack.config.json -> pack/
//   npm run build -- other.json --out dist
//   npm run build -- --verbose            also lists each git command and page
//
// On GitHub Actions, "Re-run with debug logging" turns on --verbose too.

import { dirname, resolve } from "node:path";
import { buildPack, readConfig } from "./build.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : "pack");
const configFile = resolve(args.find((arg, i) => !arg.startsWith("-") && i !== outIndex + 1) || "pack.config.json");
const verbose = args.includes("--verbose") || args.includes("-v") || process.env.RUNNER_DEBUG === "1";

try {
  const config = readConfig(configFile);
  const started = Date.now();
  buildPack(config, {
    outDir,
    baseDir: dirname(configFile),
    cacheDir: resolve(".cache"),
    repository: process.env.GITHUB_REPOSITORY,
    log: (message) => console.log(message),
    ...(verbose && { debug: (message) => console.log(`  ${message}`) }),
  });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${outDir}`);
} catch (error) {
  console.error(verbose ? error.stack : error.message);
  process.exit(1);
}
