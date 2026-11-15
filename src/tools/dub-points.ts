/** Tools: Dub.Point, a recording source from an external telecom system (e.g. BroadWorks). */
import type { Tool } from "@modelcontextprotocol/server";

/** Find_DUB_Point's documented lookup keys. */
export const DUB_POINT_FIND_KEYS = ["external_type", "service_provider", "external_group", "external_identifier"] as const;

export const DUB_POINTS_TOOLS: Tool[] = [
  {
    name: "dubber_dub_points_list",
    description:
      "List the dub points on a Dubber account, optionally only one user's (userId). Each dub point's `user` " +
      "field is a URL ending in /users/<USER_ID>. By default every page is read (100 per Dubber request, up to " +
      "10 requests) and up to `limit` dub points are returned from `offset`; if hasMore=true, call again with " +
      "offset=nextOffset. Pass `page` (and optionally `count`) instead to read one raw Dubber page.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        userId: { type: "string", description: "Only this Dubber user's dub points (Dubber `user`)." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 200,
          description: "All-pages mode: most dub points to return (1-1000). Not used with `page`.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
          default: 0,
          description: "All-pages mode: skip this many dub points (use the previous result's nextOffset). Not used with `page`.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 100,
          description: "One-page mode only (with `page`): dub points per page (1-100).",
        },
        page: {
          type: "integer",
          minimum: 0,
          description:
            "Read just this one Dubber page instead of every page. Dubber does not document whether pages start at 0 or 1.",
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
