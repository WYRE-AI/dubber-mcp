import type { DubberApi } from "../dubber-api.js";
import {
  jsonResult,
  optionalObject,
  requireId,
  requireObject,
  ToolInputError,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

async function list(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const dubPoints = await client.dubPoints.list(requireId(args, "accountId"));
  if (dubPoints.length === 0) return jsonResult({ dub_points: [], note: "No Dub.Point connections." });
  return jsonResult(dubPoints);
}

async function create(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.dubPoints.create(accountId, data));
}

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.dubPoints.get(requireId(args, "dubPointId")));
}

async function find(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const query = requireObject(args, "query");
  const stringQuery: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new ToolInputError(`Argument "query.${key}" must be a string, number, or boolean.`);
    }
    stringQuery[key] = String(value);
  }
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
