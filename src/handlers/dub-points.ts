import type { DubberApi } from "../dubber-api.js";
import { DUB_POINT_FIND_KEYS } from "../tools/dub-points.js";
import { pageArgs, pageResult, unpagedListResult } from "./paging.js";
import { jsonResult, requireId, requireObject, ToolInputError, type ToolHandler, type ToolResult } from "./results.js";

async function list(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const user = args["userId"] === undefined || args["userId"] === null ? undefined : requireId(args, "userId");
  const paging = pageArgs(args);
  const dubPoints = await client.dubPoints.list(accountId, { user, ...paging });
  return pageResult("dub_points", dubPoints, paging, "No Dub.Point connections.");
}

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.dubPoints.get(requireId(args, "dubPointId")));
}

const FIND_KEYS: readonly string[] = DUB_POINT_FIND_KEYS;

async function find(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const query = requireObject(args, "query");
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!FIND_KEYS.includes(key)) {
      throw new ToolInputError(`Argument "query.${key}" is not a Dubber dub point lookup key (use ${FIND_KEYS.join(", ")}).`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new ToolInputError(`Argument "query.${key}" must be a string and not blank.`);
    }
    params[key] = value;
  }
  if (Object.keys(params).length === 0) {
    throw new ToolInputError(`Argument "query" needs at least one of ${FIND_KEYS.join(", ")}.`);
  }
  const dubPoints = await client.dubPoints.find(params);
  return unpagedListResult("dub_points", dubPoints, "No matching Dub.Point found.", "Add lookup keys to narrow the query.");
}

export const DUB_POINTS_HANDLERS: Record<string, ToolHandler> = {
  dubber_dub_points_list: list,
  dubber_dub_points_get: get,
  dubber_dub_points_find: find,
};
