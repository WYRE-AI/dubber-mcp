/** Tools 6–8: Dubber accounts — created under a group, hold recordings and users. */
import type { Tool } from "@modelcontextprotocol/server";

export const ACCOUNTS_TOOLS: Tool[] = [
  {
    name: "dubber_accounts_create",
    description: "Create a new Dubber account.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Account name." },
        groupId: { type: "string", description: "Group to create the account under, if applicable." },
        timezone: { type: "string", description: 'IANA timezone, e.g. "Australia/Sydney".' },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
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
  {
    name: "dubber_accounts_update",
    description: "Update a Dubber account's details (e.g. name, timezone, address).",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        data: { type: "object", description: "Fields to update, as accepted by the Dubber API." },
      },
      required: ["accountId", "data"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];
