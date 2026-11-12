import type { DubberApi } from "../dubber-api.js";
import { jsonResult, requireId, type ToolHandler, type ToolResult } from "./results.js";

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.accounts.get(requireId(args, "accountId")));
}

export const ACCOUNTS_HANDLERS: Record<string, ToolHandler> = {
  dubber_accounts_get: get,
};
