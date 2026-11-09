import type { DubberApi } from "../dubber-api.js";
import { confirmDestructive, type ElicitationContext } from "../elicitation.js";
import {
  errorResult,
  jsonResult,
  optionalString,
  requireObject,
  requireId,
  requireString,
  textResult,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

const CANCELLED = "Cancelled — nothing was changed.";

async function list(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const users = await client.users.list(requireId(args, "accountId"));
  if (users.length === 0) return jsonResult({ users: [], note: "No users found." });
  return jsonResult(users);
}

async function create(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const email = requireString(args, "email");
  const name = optionalString(args, "name");
  return jsonResult(await client.users.create(accountId, { email, ...(name ? { name } : {}) }));
}

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.users.get(requireId(args, "userId")));
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
