import type { DubberApi } from "../dubber-api.js";
import { jsonResult, requireId, type ToolHandler, type ToolResult } from "./results.js";

async function list(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const notifications = await client.notifications.list(requireId(args, "accountId"));
  if (notifications.length === 0) return jsonResult({ notifications: [], note: "No notification subscriptions." });
  return jsonResult(notifications);
}

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.notifications.get(requireId(args, "notificationId")));
}

export const NOTIFICATIONS_HANDLERS: Record<string, ToolHandler> = {
  dubber_notifications_list: list,
  dubber_notifications_get: get,
};
