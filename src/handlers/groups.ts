import { unwrapList } from "@wyre-ai/node-dubber";
import type { DubberApi } from "../dubber-api.js";
import { jsonResult, requireId, type ToolHandler, type ToolResult } from "./results.js";

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.groups.get(requireId(args, "groupId")));
}

/** Get_Group_Unidentified_DUB_Points: GET /groups/:id/unidentified_dub_points (node-dubber has no method for it). */
async function listUnidentifiedDubPoints(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const groupId = requireId(args, "groupId");
  const body = await client.request<unknown>(`/groups/${encodeURIComponent(groupId)}/unidentified_dub_points`);
  const dubPoints = unwrapList(body, "unidentified_dub_points", "data");
  if (dubPoints.length === 0) return jsonResult({ unidentified_dub_points: [], note: "No unidentified dub points." });
  return jsonResult(dubPoints);
}

export const GROUPS_HANDLERS: Record<string, ToolHandler> = {
  dubber_groups_get: get,
  dubber_groups_list_unidentified_dub_points: listUnidentifiedDubPoints,
};
