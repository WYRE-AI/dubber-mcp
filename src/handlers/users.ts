import { unwrapList } from "@wyre-ai/node-dubber";
import type { DubberApi } from "../dubber-api.js";
import { confirmDestructive, type ElicitationContext } from "../elicitation.js";
import { pageArgs, pageResult } from "./paging.js";
import {
  errorResult,
  jsonResult,
  optionalString,
  requireId,
  requireObject,
  requireString,
  textResult,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

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

const CANCELLED = "Cancelled — nothing was changed.";

async function create(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const email = requireString(args, "email");
  const name = optionalString(args, "name");
  return jsonResult(await client.users.create(accountId, { email, ...(name ? { name } : {}) }));
}

async function update(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const userId = requireId(args, "userId");
  const data = requireObject(args, "data");
  return jsonResult(await client.users.update(userId, data));
}

async function deleteUser(client: DubberApi, args: Record<string, unknown>, elicitation: ElicitationContext) {
  const userId = requireId(args, "userId");
  const gate = confirmDestructive(elicitation, args, `Permanently delete Dubber user ${userId}? This cannot be undone.`);
  if (gate.kind === "ask") return gate.result;
  if (gate.kind === "blocked") return errorResult(gate.message);
  if (gate.kind === "refused") return textResult(CANCELLED);

  await client.users.delete(userId);
  return textResult(`User ${userId} deleted.`);
}

export const USERS_HANDLERS: Record<string, ToolHandler> = {
  dubber_users_list: list,
  dubber_users_create: create,
  dubber_users_get: get,
  dubber_users_update: update,
  dubber_users_delete: deleteUser,
};
