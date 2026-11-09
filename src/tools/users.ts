/** Tools: read Dubber account users. */
import type { Tool } from "@modelcontextprotocol/server";

export const USERS_TOOLS: Tool[] = [
  {
    name: "dubber_users_list",
    description:
      "List one page of users on a Dubber account (count per page, default and max 100). If the result says " +
      "hasMore=true, call again with the next page number.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        count: { type: "integer", minimum: 1, maximum: 100, default: 100, description: "Users per page (1-100)." },
        page: {
          type: "integer",
          minimum: 0,
          description: "Page number. Omit for the first page; Dubber does not document whether pages start at 0 or 1.",
        },
      },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_users_get",
    description: "Get a Dubber user's details by ID.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string", description: "Dubber user ID." } },
      required: ["userId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
