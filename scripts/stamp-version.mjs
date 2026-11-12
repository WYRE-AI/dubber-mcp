#!/usr/bin/env node
// Writes a release version into a package.json. Used by the Dockerfile build stage:
// semantic-release never commits its version bump, so without this the image would
// report "0.0.0-semantically-released" on /health and in serverInfo.
//
//   node scripts/stamp-version.mjs <version> <path/to/package.json>
//
// One leading "v" is stripped. An empty version or "unknown" (the Dockerfile's
// default VERSION build-arg) leaves the file alone. Anything that is not a plain
// semantic version (1.2.3 or 1.2.3-beta.1) is refused.
import { readFileSync, writeFileSync } from "node:fs";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const [raw, pkgPath] = process.argv.slice(2);

if (raw === undefined || pkgPath === undefined) {
  console.error("Usage: node scripts/stamp-version.mjs <version> <path/to/package.json>");
  process.exit(1);
}

if (raw === "" || raw === "unknown") {
  console.log(`No release version given; leaving ${pkgPath} unchanged.`);
  process.exit(0);
}

const version = raw.replace(/^v/, "");
if (!SEMVER.test(version)) {
  console.error(`Refusing to stamp "${raw}": not a plain semantic version (for example 2.0.1 or v2.0.1).`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Stamped ${pkgPath} with version ${version}.`);
