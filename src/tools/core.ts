/** Tool 1: the connection check. */
import type { Tool } from "@modelcontextprotocol/server";

export const CORE_TOOLS: Tool[] = [
  {
    name: "dubber_test_connection",
    description:
      "Verify Dubber API credentials by minting an OAuth token. Reports whether the mint " +
      "succeeded; a successful mint does not prove any specific account/product access.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
