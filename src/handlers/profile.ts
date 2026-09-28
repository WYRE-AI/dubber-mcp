import type { DubberClient } from "@wyre-ai/node-dubber";
import { jsonResult, type ToolHandler, type ToolResult } from "./results.js";

async function get(client: DubberClient): Promise<ToolResult> {
  return jsonResult(await client.profile.get());
}

export const PROFILE_HANDLERS: Record<string, ToolHandler> = {
  dubber_profile_get: get,
};
