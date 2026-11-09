/** Tools: read REST-hook (webhook) notification subscriptions, account-scoped. */
import type { Tool } from "@modelcontextprotocol/server";

export const NOTIFICATIONS_TOOLS: Tool[] = [
  {
    name: "dubber_notifications_list",
    description: "List REST-hook (webhook) notification subscriptions on a Dubber account.",
    inputSchema: {
      type: "object",
      properties: { accountId: { type: "string", description: "Dubber account ID." } },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_notifications_get",
    description: "Get a notification subscription's details by ID.",
    inputSchema: {
      type: "object",
      properties: { notificationId: { type: "string", description: "Dubber notification ID." } },
      required: ["notificationId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
