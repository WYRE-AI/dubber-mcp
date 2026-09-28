/** Credential resolution + stateless tool-list invariants. */
import { describe, expect, it } from "vitest";
import {
  buildCredentials,
  createMcpServer,
  GATEWAY_HEADERS,
  listToolsResult,
  makeMcpServerFactory,
  REQUIRED_GATEWAY_HEADERS,
  resolveEnvCredentials,
  resolveGatewayCredentials,
} from "../mcp-server.js";
import { TOOLS } from "../tools/index.js";

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

  it("passes through an explicit region", () => {
    const { creds } = buildCredentials("id", "secret", "auth-id", "auth-token", "us");
    expect(creds?.region).toBe("us");
  });

  it("names every missing required header", () => {
    const { creds, error } = buildCredentials(undefined, undefined, undefined, undefined);
    expect(creds).toBeUndefined();
    for (const header of REQUIRED_GATEWAY_HEADERS) expect(error).toContain(header);
  });

  it("treats empty strings as absent", () => {
    expect(buildCredentials("", "secret", "auth-id", "auth-token").error).toContain(
      "X-Dubber-Client-Id"
    );
  });
});

describe("resolveGatewayCredentials", () => {
  it("reads the exact lowercased x-dubber-* headers", () => {
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
    expect(creds).toEqual({
      clientId: "id",
      clientSecret: "secret",
      authId: "auth-id",
      authToken: "auth-token",
      region: "us",
    });
    expect(seen).toEqual(GATEWAY_HEADERS.map((h) => h.toLowerCase()));
  });

  it("errors when a required header is absent", () => {
    const { error } = resolveGatewayCredentials((name) =>
      name === "x-dubber-client-id" ? "id" : undefined
    );
    expect(error).toBeTruthy();
  });

  it("never carries a base URL (env mode only — SSRF guard)", () => {
    const { creds } = resolveGatewayCredentials((name) =>
      name === "x-dubber-base-url" ? "https://attacker.example" : `v-${name}`
    );
    expect((creds as unknown as { baseUrl?: string })?.baseUrl).toBeUndefined();
  });
});

describe("resolveEnvCredentials", () => {
  it("reads DUBBER_* env vars, including the base URL", () => {
    const { creds } = resolveEnvCredentials({
      DUBBER_CLIENT_ID: "id",
      DUBBER_CLIENT_SECRET: "secret",
      DUBBER_AUTH_ID: "auth-id",
      DUBBER_AUTH_TOKEN: "auth-token",
      DUBBER_BASE_URL: "https://dubber.test.invalid",
    });
    expect(creds).toEqual({
      clientId: "id",
      clientSecret: "secret",
      authId: "auth-id",
      authToken: "auth-token",
      region: "sandbox",
      baseUrl: "https://dubber.test.invalid",
    });
  });

  it("defaults region to sandbox when unset", () => {
    const { creds } = resolveEnvCredentials({
      DUBBER_CLIENT_ID: "id",
      DUBBER_CLIENT_SECRET: "s",
      DUBBER_AUTH_ID: "a",
      DUBBER_AUTH_TOKEN: "t",
    });
    expect(creds?.region).toBe("sandbox");
    expect(creds?.baseUrl).toBeUndefined();
  });
});

describe("stateless tool surface", () => {
  it("returns the module-scope TOOLS array by reference every time", () => {
    expect(listToolsResult().tools).toBe(TOOLS);
    expect(listToolsResult().tools).toBe(listToolsResult().tools);
  });

  it("is identical (same order) regardless of credentials", () => {
    createMcpServer();
    const withoutCreds = listToolsResult().tools.map((t) => t.name);
    createMcpServer({ clientId: "id", clientSecret: "secret", authId: "a", authToken: "t" });
    const withCreds = listToolsResult().tools.map((t) => t.name);
    expect(withoutCreds).toEqual(withCreds);
  });
});

describe("makeMcpServerFactory", () => {
  it("builds a server from gateway headers per request", () => {
    const factory = makeMcpServerFactory({ gatewayMode: true });
    const headers = new Map<string, string>([
      ["x-dubber-client-id", "id"],
      ["x-dubber-client-secret", "secret"],
      ["x-dubber-auth-id", "a"],
      ["x-dubber-auth-token", "t"],
    ]);
    const server = factory({
      requestInfo: { headers: { get: (n: string) => headers.get(n) ?? null } },
    } as never);
    expect(server).toBeTruthy();
  });

  it("never throws even with no credentials (401 gate lives in the HTTP layer)", () => {
    const factory = makeMcpServerFactory({ gatewayMode: true });
    expect(() =>
      factory({
        requestInfo: { headers: { get: () => null } },
      } as never)
    ).not.toThrow();
  });
});
