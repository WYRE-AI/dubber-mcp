/** Credential resolution, region allowlist, and the per-request server factory. */
import { afterEach, describe, expect, it } from "vitest";
import { lockGatewayMode, resetGatewayLock } from "../config.js";
import {
  buildCredentials,
  GATEWAY_HEADERS,
  REQUIRED_GATEWAY_HEADERS,
  resolveEnvCredentials,
  resolveGatewayCredentials,
} from "../credentials.js";
import { readFileSync } from "node:fs";
import { makeMcpServerFactory, SERVER_VERSION } from "../mcp-server.js";
import { runInRequestScope } from "../request-scope.js";

describe("buildCredentials", () => {
  it("accepts the four required fields, defaulting region to sandbox", () => {
    const { creds, error } = buildCredentials("id", "secret", "auth-id", "auth-token");
    expect(error).toBeUndefined();
    expect(creds).toEqual({
      clientId: "id",
      clientSecret: "secret",
      authId: "auth-id",
      authToken: "auth-token",
      region: "sandbox",
    });
  });

  it("accepts every allowlisted region, case-insensitively", () => {
    for (const region of ["sandbox", "us", "au", "eu", "UK"]) {
      expect(buildCredentials("id", "s", "a", "t", region).creds?.region).toBe(region.toLowerCase());
    }
  });

  it("rejects a region outside the allowlist before it can reach a URL", () => {
    for (const region of ["zz", "us/../evil", "sandbox/v1/accounts", "@evil.example", "us?x=1"]) {
      const { creds, error } = buildCredentials("id", "s", "a", "t", region);
      expect(creds, region).toBeUndefined();
      expect(error, region).toContain("Invalid Dubber region");
      expect(error, region).not.toContain(region);
    }
  });

  it("rejects a present but blank region instead of defaulting to sandbox", () => {
    const { creds, error } = buildCredentials("id", "s", "a", "t", "   ");
    expect(creds).toBeUndefined();
    expect(error).toContain("Invalid Dubber region");
  });

  it("names every missing required header", () => {
    const { creds, error } = buildCredentials(undefined, undefined, undefined, undefined);
    expect(creds).toBeUndefined();
    for (const header of REQUIRED_GATEWAY_HEADERS) expect(error).toContain(header);
  });

  it("treats empty strings as absent", () => {
    expect(buildCredentials("", "secret", "auth-id", "auth-token").error).toContain("X-Dubber-Client-Id");
  });
});

describe("resolveGatewayCredentials", () => {
  it("reads exactly the lowercased X-Dubber-* headers", () => {
    const headers: Record<string, string> = {
      "x-dubber-client-id": "id",
      "x-dubber-client-secret": "secret",
      "x-dubber-auth-id": "auth-id",
      "x-dubber-auth-token": "auth-token",
      "x-dubber-region": "us",
    };
    const seen: string[] = [];
    const { creds } = resolveGatewayCredentials((name) => {
      seen.push(name);
      return headers[name];
    });
    expect(creds).toEqual({ clientId: "id", clientSecret: "secret", authId: "auth-id", authToken: "auth-token", region: "us" });
    expect(seen).toEqual(GATEWAY_HEADERS.map((h) => h.toLowerCase()));
  });

  it("errors when a required header is absent", () => {
    expect(resolveGatewayCredentials((name) => (name === "x-dubber-client-id" ? "id" : undefined)).error).toBeTruthy();
  });

  it("has no base-URL input at all", () => {
    const { creds } = resolveGatewayCredentials((name) =>
      name === "x-dubber-base-url" ? "https://attacker.example" : name === "x-dubber-region" ? "us" : `v-${name}`
    );
    expect(Object.keys(creds ?? {}).sort()).toEqual(["authId", "authToken", "clientId", "clientSecret", "region"]);
  });
});

describe("resolveEnvCredentials", () => {
  it("reads DUBBER_* env vars and ignores DUBBER_BASE_URL", () => {
    const { creds } = resolveEnvCredentials({
      DUBBER_CLIENT_ID: "id",
      DUBBER_CLIENT_SECRET: "secret",
      DUBBER_AUTH_ID: "auth-id",
      DUBBER_AUTH_TOKEN: "auth-token",
      DUBBER_BASE_URL: "https://dubber.test.invalid",
    });
    expect(creds).toEqual({ clientId: "id", clientSecret: "secret", authId: "auth-id", authToken: "auth-token", region: "sandbox" });
  });

  it("treats an empty DUBBER_REGION (as in a copied .env) as unset", () => {
    const { creds } = resolveEnvCredentials({
      DUBBER_CLIENT_ID: "id",
      DUBBER_CLIENT_SECRET: "secret",
      DUBBER_AUTH_ID: "auth-id",
      DUBBER_AUTH_TOKEN: "auth-token",
      DUBBER_REGION: " ",
    });
    expect(creds?.region).toBe("sandbox");
  });
});

describe("makeMcpServerFactory", () => {
  afterEach(() => resetGatewayLock());

  it("never throws, with or without a request scope (the 401 gate lives in the HTTP layer)", () => {
    lockGatewayMode();
    const factory = makeMcpServerFactory();
    expect(() => factory({} as never)).not.toThrow();
    expect(() => runInRequestScope({ tiers: new Set() }, () => factory({} as never))).not.toThrow();
  });
});

describe("SERVER_VERSION", () => {
  it("follows package.json (semantic-release bumps it), like the template's version.ts", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
