import { readFileSync } from "node:fs";

/**
 * Read from package.json at runtime for /health and serverInfo. The committed package.json carries a
 * placeholder version, because semantic-release never commits its version bump. Released images get the
 * real version from the VERSION build-arg: the Dockerfile runs scripts/stamp-version.mjs before the build.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
