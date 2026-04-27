// Sourced from package.json — `resolveJsonModule` is enabled in tsconfig.json.
// Synchronous fs read avoids ESM import-attribute compatibility issues across
// Node versions while keeping the version string in lock-step with the manifest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// At build time, this file lives at build/version.js, so `..` reaches the
// project root where package.json lives. The src layout (src/version.ts) is
// a single level deeper at runtime — only the build path matters.
const manifestPath = join(here, "..", "package.json");
const pkg = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  name: string;
  version: string;
};

export const VERSION: string = pkg.version;
export const NAME: string = pkg.name;
