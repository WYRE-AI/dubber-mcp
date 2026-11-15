/** Tools: group details and a group's unidentified dub points. */
import type { Tool } from "@modelcontextprotocol/server";

export const GROUPS_TOOLS: Tool[] = [
  {
    name: "dubber_groups_get",
    description: "Get a Dubber group's details by ID.",
    inputSchema: {
      type: "object",
      properties: { groupId: { type: "string", description: "Dubber group ID." } },
      required: ["groupId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_groups_list_unidentified_dub_points",
    description:
      "List a group's unidentified dub points: recording sources Dubber has seen but not yet assigned to an " +
      "account. Dubber answers this only for a group-level API token; an account-level token gets an error.",
    inputSchema: {
      type: "object",
      properties: { groupId: { type: "string", description: "Dubber group ID." } },
      required: ["groupId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
