import type { DubberApi } from "../dubber-api.js";
import { jsonResult, type ToolHandler, type ToolResult } from "./results.js";

async function get(client: DubberApi): Promise<ToolResult> {
  return jsonResult(await client.profile.get());
}

export const PROFILE_HANDLERS: Record<string, ToolHandler> = {
  dubber_profile_get: get,
};
