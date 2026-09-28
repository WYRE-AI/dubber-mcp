/** Tools: Dub.Point — connects an external telecom system (e.g. BroadWorks) to Dubber recording. */
import type { Tool } from "@modelcontextprotocol/server";

export const DUB_POINTS_TOOLS: Tool[] = [
  {
    name: "dubber_dub_points_list",
    description: "List Dub.Point telecom-system connections on a Dubber account.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string", description: "Dubber account ID." } },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_dub_points_create",
    description: "Create a Dub.Point connection on a Dubber account (e.g. to a BroadWorks trunk).",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        data: { type: "object", description: "Dub.Point fields as accepted by the Dubber API." },
      },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_dub_points_get",
    description: "Get a Dub.Point's details by ID.",
    inputSchema: {
      type: "object",
      properties: { dubPointId: { type: "string", description: "Dubber Dub.Point ID." } },
      required: ["dubPointId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_dub_points_find",
    description:
      "Look up a Dub.Point by external-system identifiers (e.g. a BroadWorks user or trunk ID).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "object",
          description: "Lookup parameters as accepted by the Dubber API (external-system-specific).",
        },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
