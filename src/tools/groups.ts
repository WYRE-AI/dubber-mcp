/** Tools 2–5: group hierarchy and group-scoped unidentified (unclaimed) recordings. */
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
    name: "dubber_groups_create_child",
    description: "Create a child group under an existing Dubber group.",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "Parent Dubber group ID." },
        name: { type: "string", description: "Name for the new child group." },
      },
      required: ["groupId", "name"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_groups_list_unidentified_recordings",
    description:
      "List unidentified/unclaimed recordings for a group — recordings Dubber captured but " +
      "could not automatically associate with an account or Dub.Point.",
    inputSchema: {
      type: "object",
      properties: { groupId: { type: "string", description: "Dubber group ID." } },
      required: ["groupId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_groups_create_unidentified_recording",
    description:
      "Create an unidentified-recording entry under a group (e.g. to register a recording " +
      "captured outside the normal account/Dub.Point flow).",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "Dubber group ID." },
        data: {
          type: "object",
          description: "Recording fields as accepted by the Dubber API.",
        },
      },
      required: ["groupId"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];
