import { unwrapList } from "@wyre-ai/node-dubber";
import type { DubberApi } from "../dubber-api.js";
import { pageArgs, pageResult } from "./paging.js";
import { jsonResult, requireId, type ToolHandler, type ToolResult } from "./results.js";

/** Get_Account_Users pages with count/page; node-dubber's users.list sends neither, so call the endpoint directly. */
async function list(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const paging = pageArgs(args);
  const body = await client.request<unknown>(`/accounts/${encodeURIComponent(accountId)}/users`, {
    params: { count: paging.count, page: paging.page },
  });
  return pageResult("users", unwrapList(body, "users", "data"), paging, "No users found.");
}

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.users.get(requireId(args, "userId")));
}

export const USERS_HANDLERS: Record<string, ToolHandler> = {
  dubber_users_list: list,
  dubber_users_get: get,
};
