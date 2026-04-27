#!/usr/bin/env node
// @ts-check
/**
 * setup-hooks.mjs
 *
 * Activates the repo's local git hooks by pointing `core.hooksPath` at
 * `.githooks/`. Runs automatically via the npm `prepare` lifecycle after
 * `npm install`, so contributors get fast pre-commit/pre-push checks with
 * zero manual setup.
 *
 * Safety:
 *   - No-ops when not inside a git working tree (e.g. when this package is
 *     installed as a dependency by someone else, or unpacked from a tarball).
 *   - No-ops when `.githooks` is already configured to avoid noisy reruns.
 *   - Never fails the install — `prepare` running inside `npm install` for a
 *     consumer of this package must not crash even if git is missing.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const hooksDir = join(repoRoot, ".githooks");

function run(cmd) {
  return execSync(cmd, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function main() {
  try {
    // Only proceed if we're inside a git work tree.
    const insideWorkTree = run("git rev-parse --is-inside-work-tree");
    if (insideWorkTree !== "true") return;

    // Ensure we are running from the repo root, not from a consumer's node_modules.
    // When installed as a dependency, repoRoot points inside node_modules and the
    // git root will be the consumer's repo — skip hook installation in that case.
    const gitRoot = run("git rev-parse --show-toplevel");
    if (gitRoot !== repoRoot) return;

    if (!existsSync(hooksDir)) {
      // Repo was checked out without the .githooks dir (shouldn't happen, but
      // bail safely if it does).
      return;
    }

    // Skip if already configured to avoid log noise on every install.
    let current = "";
    try {
      current = run("git config --local --get core.hooksPath");
    } catch {
      current = "";
    }
    if (current === ".githooks") return;

    execSync("git config core.hooksPath .githooks", {
      cwd: repoRoot,
      stdio: "ignore",
    });
    console.log(
      "setup-hooks: activated .githooks/ (pre-commit, pre-push, post-commit)"
    );
  } catch {
    // Swallow — never break `npm install`.
  }
}

main();
