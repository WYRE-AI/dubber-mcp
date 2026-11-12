/** Tools: Dub.Point, a recording source from an external telecom system (e.g. BroadWorks). */
import type { Tool } from "@modelcontextprotocol/server";

/** Find_DUB_Point's documented lookup keys. */
export const DUB_POINT_FIND_KEYS = ["external_type", "service_provider", "external_group", "external_identifier"] as const;

export const DUB_POINTS_TOOLS: Tool[] = [
  {
    name: "dubber_dub_points_list",
    description:
      "List one page of dub points on a Dubber account, optionally only one user's (userId). Each dub point's " +
      "`user` field is a URL ending in /users/<USER_ID>. If the result says hasMore=true, call again with the " +
      "next page number.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        userId: { type: "string", description: "Only this Dubber user's dub points (Dubber `user`)." },
        count: { type: "integer", minimum: 1, maximum: 100, default: 100, description: "Dub points per page (1-100)." },
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
    description: "Look up a Dub.Point by its external-system identifiers (e.g. a BroadWorks user ID).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "object",
          description: "At least one of Dubber's lookup keys.",
          properties: {
            external_type: { type: "string", description: 'External system type, e.g. "broadworks".' },
            service_provider: { type: "string", description: "Service provider identifier." },
            external_group: { type: "string", description: "Group identifier in the external system." },
            external_identifier: { type: "string", description: "User or line identifier in the external system." },
          },
          additionalProperties: false,
        },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
