/** Tool 1: the connection check. */
import type { Tool } from "@modelcontextprotocol/server";

export const CORE_TOOLS: Tool[] = [
  {
    name: "dubber_test_connection",
    description:
      "Verify Dubber API credentials with one authenticated GET /profile (minting an OAuth token " +
      "only if none is cached). A success does not prove any specific account/product access.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
