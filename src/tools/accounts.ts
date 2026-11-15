/** Tool: read a Dubber account. */
import type { Tool } from "@modelcontextprotocol/server";

export const ACCOUNTS_TOOLS: Tool[] = [
  {
    name: "dubber_accounts_get",
    description: "Get a Dubber account's details by ID.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string", description: "Dubber account ID." } },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
