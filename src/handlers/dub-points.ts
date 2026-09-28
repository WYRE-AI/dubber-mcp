import type { DubberClient } from "@wyre-ai/node-dubber";
import { jsonResult, optionalObject, requireObject, requireString, type ToolHandler, type ToolResult } from "./results.js";

async function list(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const dubPoints = await client.dubPoints.list(requireString(args, "accountId"));
  if (dubPoints.length === 0) return jsonResult({ dub_points: [], note: "No Dub.Point connections." });
  return jsonResult(dubPoints);
}

async function create(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireString(args, "accountId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.dubPoints.create(accountId, data));
}

async function get(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.dubPoints.get(requireString(args, "dubPointId")));
}

async function find(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const query = requireObject(args, "query");
  const stringQuery = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const dubPoints = await client.dubPoints.find(stringQuery);
  if (dubPoints.length === 0) return jsonResult({ dub_points: [], note: "No matching Dub.Point found." });
  return jsonResult(dubPoints);
}

export const DUB_POINTS_HANDLERS: Record<string, ToolHandler> = {
  dubber_dub_points_list: list,
  dubber_dub_points_create: create,
  dubber_dub_points_get: get,
  dubber_dub_points_find: find,
};
