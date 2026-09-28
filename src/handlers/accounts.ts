import type { DubberClient } from "@wyre-ai/node-dubber";
import {
  jsonResult,
  optionalString,
  requireObject,
  requireString,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

async function create(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const name = requireString(args, "name");
  const groupId = optionalString(args, "groupId");
  const timezone = optionalString(args, "timezone");
  return jsonResult(
    await client.accounts.create({
      name,
      ...(groupId ? { group_id: groupId } : {}),
      ...(timezone ? { timezone } : {}),
    })
  );
}

async function get(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.accounts.get(requireString(args, "accountId")));
}

async function update(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireString(args, "accountId");
  const data = requireObject(args, "data");
  return jsonResult(await client.accounts.update(accountId, data));
}

export const ACCOUNTS_HANDLERS: Record<string, ToolHandler> = {
  dubber_accounts_create: create,
  dubber_accounts_get: get,
  dubber_accounts_update: update,
};
