/** Tools: REST-hook (webhook) notification subscriptions, account-scoped. */
import type { Tool } from "@modelcontextprotocol/server";
import { CONFIRM_ARG_PROPERTY } from "../elicitation.js";

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
    name: "dubber_notifications_create",
    description:
      "Create a REST-hook (webhook) notification subscription on a Dubber account. Created " +
      "subscriptions are inactive until dubber_notifications_activate is called.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        url: { type: "string", description: "Webhook URL Dubber will POST events to." },
        event: { type: "string", description: 'Event to subscribe to, e.g. "recording.created".' },
      },
      required: ["accountId", "url", "event"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
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
  {
    name: "dubber_notifications_update",
    description: "Update a notification subscription (e.g. its target URL).",
    inputSchema: {
      type: "object",
      properties: {
        notificationId: { type: "string", description: "Dubber notification ID." },
        data: { type: "object", description: "Fields to update, as accepted by the Dubber API." },
      },
      required: ["notificationId", "data"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_notifications_activate",
    description: "Activate a notification subscription so it starts firing.",
    inputSchema: {
      type: "object",
      properties: { notificationId: { type: "string", description: "Dubber notification ID." } },
      required: ["notificationId"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_notifications_list_unclaimed",
    description: "List unclaimed/undelivered events pending for a notification subscription.",
    inputSchema: {
      type: "object",
      properties: { notificationId: { type: "string", description: "Dubber notification ID." } },
      required: ["notificationId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_notifications_delete",
    description:
      "⚠ HIGH-IMPACT. Deletes a notification subscription; the integration stops receiving " +
      "events immediately. Reversible by re-creating the subscription, but any events fired " +
      "in the meantime are lost. Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        notificationId: { type: "string", description: "Dubber notification ID." },
        ...CONFIRM_ARG_PROPERTY,
      },
      required: ["notificationId"],
    },
    annotations: {
      title: "Delete notification subscription",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
