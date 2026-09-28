/**
 * End-to-end elicitation over the REAL serving stack: the same
 * createMcpHandler({ legacy: 'stateless' }) + toNodeHandler wiring as
 * src/index.ts, with only the vendor DubberClient stubbed.
 *
 * Proves the MRTR seam on both protocol eras, using dubber_recordings_delete:
 * - a 2026-07-28 client with the elicitation capability gets the delete
 *   confirmation as an embedded `elicitation/create` request (auto-fulfilled
 *   by the v2 client) — decline cancels the delete, accept lets it fire;
 * - a stateless 2025-era caller (no capability view) — how the WYRE Conduit
 *   gateway connects — cannot be prompted, so the delete is BLOCKED unless
 *   the request carries an explicit `confirm_destructive_action`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

const RECORDING_ID = "rec-elicit-1";

const { recordingsApi } = vi.hoisted(() => ({
  recordingsApi: {
    delete: vi.fn(),
  },
}));

vi.mock("@wyre-ai/node-dubber", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wyre-ai/node-dubber")>();
  return {
    ...actual,
    DubberClient: class {
      recordings = recordingsApi;
    },
  };
});

const { makeMcpServerFactory } = await import("../mcp-server.js");

const ENV_KEYS = ["DUBBER_CLIENT_ID", "DUBBER_CLIENT_SECRET", "DUBBER_AUTH_ID", "DUBBER_AUTH_TOKEN"] as const;

describe("elicitation over the live dual-era serving stack", () => {
  let mcpHandler: McpHttpHandler;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    for (const key of ENV_KEYS) process.env[key] = "test-value";
    mcpHandler = createMcpHandler(makeMcpServerFactory({ gatewayMode: false }), {
      legacy: "stateless",
    });
    const handleMcp = toNodeHandler(mcpHandler);
    server = http.createServer((req, res) => {
      void handleMcp(req as unknown as Parameters<typeof handleMcp>[0], res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    await mcpHandler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    recordingsApi.delete.mockReset();
    recordingsApi.delete.mockResolvedValue(undefined);
  });

  async function modernDelete(confirm: boolean): Promise<{ prompts: string[]; text: string }> {
    const { Client, StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/client"
    );
    const prompts: string[] = [];
    const client = new Client(
      { name: "elicit-e2e", version: "0.0.0" },
      {
        capabilities: { elicitation: {} },
        // Negotiate the modern era — the default is a plain 2025 connect.
        versionNegotiation: { mode: "auto" },
      }
    );
    client.setRequestHandler("elicitation/create", async (request) => {
      prompts.push(request.params.message);
      return { action: "accept" as const, content: { confirm } };
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const result = await client.callTool({
        name: "dubber_recordings_delete",
        arguments: { recordingId: RECORDING_ID },
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      return { prompts, text: content[0]?.text ?? "" };
    } finally {
      await client.close();
    }
  }

  it("2026-07-28 era: declined confirmation cancels the delete", async () => {
    const { prompts, text } = await modernDelete(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(RECORDING_ID);
    expect(text).toContain("Cancelled");
    expect(recordingsApi.delete).not.toHaveBeenCalled();
  });

  it("2026-07-28 era: accepted confirmation lets the delete fire once", async () => {
    const { prompts, text } = await modernDelete(true);
    expect(prompts).toHaveLength(1);
    expect(recordingsApi.delete).toHaveBeenCalledTimes(1);
    expect(recordingsApi.delete).toHaveBeenCalledWith(RECORDING_ID);
    expect(text).toContain("deleted");
  });

  /** One stateless 2025-era tools/call — no initialize, so no capability view. */
  async function statelessDelete(
    args: Record<string, unknown>
  ): Promise<{ isError?: boolean; text: string }> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "dubber_recordings_delete", arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    const message = JSON.parse(
      (dataLines.length > 0 ? dataLines[dataLines.length - 1].slice(5) : text).trim()
    );
    return {
      isError: message.result?.isError,
      text: message.result?.content?.[0]?.text ?? "",
    };
  }

  it("stateless 2025-era caller: no capability view → the delete is blocked, not assumed", async () => {
    const { isError, text } = await statelessDelete({ recordingId: RECORDING_ID });
    expect(isError).toBe(true);
    expect(text).toContain("confirm_destructive_action");
    expect(recordingsApi.delete).not.toHaveBeenCalled();
  });

  it("stateless 2025-era caller: explicit confirmation lets the delete fire", async () => {
    const { isError } = await statelessDelete({
      recordingId: RECORDING_ID,
      confirm_destructive_action: true,
    });
    expect(isError).toBeFalsy();
    expect(recordingsApi.delete).toHaveBeenCalledTimes(1);
  });
});
