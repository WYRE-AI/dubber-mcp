import type { DubberClient } from "@wyre-ai/node-dubber";
import { confirmDestructive, type ElicitationContext } from "../elicitation.js";
import {
  errorResult,
  jsonResult,
  requireObject,
  requireString,
  textResult,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

const CANCELLED = "Cancelled — nothing was changed.";

async function list(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const notifications = await client.notifications.list(requireString(args, "accountId"));
  if (notifications.length === 0) return jsonResult({ notifications: [], note: "No notification subscriptions." });
  return jsonResult(notifications);
}

async function create(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireString(args, "accountId");
  const url = requireString(args, "url");
  const event = requireString(args, "event");
  return jsonResult(await client.notifications.create(accountId, { url, event }));
}

async function get(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.notifications.get(requireString(args, "notificationId")));
}

async function update(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const notificationId = requireString(args, "notificationId");
  const data = requireObject(args, "data");
  return jsonResult(await client.notifications.update(notificationId, data));
}

async function activate(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.notifications.activate(requireString(args, "notificationId")));
}

async function listUnclaimed(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const events = await client.notifications.listUnclaimed(requireString(args, "notificationId"));
  if (events.length === 0) return jsonResult({ events: [], note: "No unclaimed events." });
  return jsonResult(events);
}

async function deleteNotification(
  client: DubberClient,
  args: Record<string, unknown>,
  elicitation: ElicitationContext
) {
  const notificationId = requireString(args, "notificationId");
  const gate = confirmDestructive(
    elicitation,
    args,
    `Delete notification subscription ${notificationId}? The integration stops receiving events immediately.`
  );
  if (gate.kind === "ask") return gate.result;
  if (gate.kind === "blocked") return errorResult(gate.message);
  if (gate.kind === "refused") return textResult(CANCELLED);

  await client.notifications.delete(notificationId);
  return textResult(`Notification subscription ${notificationId} deleted.`);
}

export const NOTIFICATIONS_HANDLERS: Record<string, ToolHandler> = {
  dubber_notifications_list: list,
  dubber_notifications_create: create,
  dubber_notifications_get: get,
  dubber_notifications_update: update,
  dubber_notifications_activate: activate,
  dubber_notifications_list_unclaimed: listUnclaimed,
  dubber_notifications_delete: deleteNotification,
};
