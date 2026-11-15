/**
 * scripts/stamp-version.mjs writes the release version into package.json during the
 * Docker build, because semantic-release never commits its version bump and
 * /health and serverInfo read package.json. Runs the script as the Dockerfile does,
 * against a temporary copy of package.json.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/stamp-version.mjs", import.meta.url));
const ORIGINAL = `${JSON.stringify({ name: "x", version: "0.0.0-semantically-released", type: "module" }, null, 2)}\n`;

let dir: string;
let pkgPath: string;

function stamp(version: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, version, pkgPath], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

const versionInFile = () => (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stamp-version-"));
  pkgPath = join(dir, "package.json");
  writeFileSync(pkgPath, ORIGINAL);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("stamp-version", () => {
  it("writes a plain semantic version and keeps the rest of the file", () => {
    expect(stamp("2.0.1").status).toBe(0);
    expect(readFileSync(pkgPath, "utf8")).toBe(ORIGINAL.replace("0.0.0-semantically-released", "2.0.1"));
  });

  it("strips exactly one leading v", () => {
    expect(stamp("v2.1.0").status).toBe(0);
    expect(versionInFile()).toBe("2.1.0");
  });

  it("accepts a prerelease", () => {
    expect(stamp("2.1.0-beta.1").status).toBe(0);
    expect(versionInFile()).toBe("2.1.0-beta.1");
  });

  it.each(["", "unknown"])("does nothing for %j", (version) => {
    expect(stamp(version).status).toBe(0);
    expect(readFileSync(pkgPath, "utf8")).toBe(ORIGINAL);
  });

  it.each(["vv2.0.0", "2.0", "latest", "2.0.0 && rm -rf /", "../2.0.0", "2.0.0\n"])(
    "refuses %j and leaves the file alone",
    (version) => {
      const result = stamp(version);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not a plain semantic version");
      expect(readFileSync(pkgPath, "utf8")).toBe(ORIGINAL);
    }
  );

  it("fails when the package.json path is missing", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "2.0.0"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage");
  });
});
