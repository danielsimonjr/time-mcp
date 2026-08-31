import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package version — from esbuild define in bundles, else package.json at runtime. */
export const PKG_VERSION: string = (() => {
  try {
    // Replaced with a string literal when bundled via scripts/build.mjs.
    return __PKG_VERSION__;
  } catch {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version as string;
  }
})();
