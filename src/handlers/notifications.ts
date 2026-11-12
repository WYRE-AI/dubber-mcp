import type { DubberApi } from "../dubber-api.js";
import { unpagedListResult } from "./paging.js";
import { jsonResult, requireId, type ToolHandler, type ToolResult } from "./results.js";

async function list(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const notifications = await client.notifications.list(requireId(args, "accountId"));
  return unpagedListResult(
    "notifications",
    notifications,
    "No notification subscriptions.",
    "Use dubber_notifications_get with an id for any subscription not listed."
  );
}

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.notifications.get(requireId(args, "notificationId")));
}

export const NOTIFICATIONS_HANDLERS: Record<string, ToolHandler> = {
  dubber_notifications_list: list,
  dubber_notifications_get: get,
};
