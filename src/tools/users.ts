/** Tools: Dubber account users. */
import type { Tool } from "@modelcontextprotocol/server";
import { CONFIRM_ARG_PROPERTY } from "../elicitation.js";

export const USERS_TOOLS: Tool[] = [
  {
    name: "dubber_users_list",
    description: "List users on a Dubber account.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string", description: "Dubber account ID." } },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_users_create",
    description: "Create a new user on a Dubber account.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        email: { type: "string", description: "User's email address." },
        name: { type: "string", description: "User's display name." },
      },
      required: ["accountId", "email"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
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
  {
    name: "dubber_users_update",
    description: "Update a Dubber user's details (e.g. name, role).",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Dubber user ID." },
        data: { type: "object", description: "Fields to update, as accepted by the Dubber API." },
      },
      required: ["userId", "data"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_users_delete",
    description:
      "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a Dubber user. This action cannot " +
      "be undone. Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string", description: "Dubber user ID." }, ...CONFIRM_ARG_PROPERTY },
      required: ["userId"],
    },
    annotations: {
      title: "Delete user (irreversible)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];
