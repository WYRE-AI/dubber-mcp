import type { DubPoint } from "@wyre-ai/node-dubber";
import { rateLimitOf, type DubberApi } from "../dubber-api.js";
import { DUB_POINT_FIND_KEYS } from "../tools/dub-points.js";
import { MAX_PAGE_COUNT, pageArgs, pageResult, unpagedListResult } from "./paging.js";
import {
  jsonResult,
  listResult,
  optionalIntegerInRange,
  requireId,
  requireObject,
  ToolInputError,
  trimNote,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

/** Hard cap on Dubber requests per auto-paged call (10 * 100 = 1,000 dub points scanned). */
export const DUB_POINTS_MAX_REQUESTS = 10;
export const DUB_POINTS_DEFAULT_LIMIT = 200;
export const DUB_POINTS_MAX_LIMIT = DUB_POINTS_MAX_REQUESTS * MAX_PAGE_COUNT;

interface WalkResult {
  items: DubPoint[];
  requests: number;
  /** complete: a short/empty page; enough: offset+limit+1 collected; cap: request cap; no-progress: a full page with no new ids; rate-limited. */
  stop: "complete" | "enough" | "cap" | "no-progress" | "rate-limited";
  rateLimit?: "daily" | "retry";
}

/**
 * Walk every page of Get_Account_Dub_Points with count=100 (WYREAI-567: one
 * unpaged call stopped at Dubber's default 20).
 *
 * Dubber documents `page` but not whether it is 0- or 1-based, so (like
 * node-dubber's listAll) the first request omits `page`, then asks for page=1,
 * 2, 3, ...: under 1-based paging page=1 repeats the first page and every id is
 * skipped by the dedupe; under 0-based paging it is the real second page.
 * Stops on a short page, once `want` dub points are collected, on a full page
 * after page=1 with no new ids (a server ignoring `page`), or at the request cap.
 */
async function walkDubPoints(client: DubberApi, accountId: string, user: string | undefined, want: number): Promise<WalkResult> {
  const items: DubPoint[] = [];
  const seen = new Set<string>();
  let requests = 0;
  for (let page: number | undefined = undefined; ; page = page === undefined ? 1 : page + 1) {
    if (requests >= DUB_POINTS_MAX_REQUESTS) return { items, requests, stop: "cap" };
    let batch: DubPoint[];
    try {
      batch = await client.dubPoints.list(accountId, {
        ...(user === undefined ? {} : { user }),
        count: MAX_PAGE_COUNT,
        ...(page === undefined ? {} : { page }),
      });
    } catch (error) {
      const rateLimit = rateLimitOf(error);
      // Nothing read yet: report the error. Otherwise keep what was read.
      if (!rateLimit || requests === 0) throw error;
      return { items, requests, stop: "rate-limited", rateLimit: rateLimit.kind };
    }
    requests += 1;
    let fresh = 0;
    for (const dp of batch) {
      const id = typeof dp.id === "string" && dp.id !== "" ? dp.id : undefined;
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      fresh += 1;
      items.push(dp);
    }
    if (batch.length < MAX_PAGE_COUNT) return { items, requests, stop: "complete" };
    if (items.length >= want) return { items, requests, stop: "enough" };
    // page=1 may legitimately repeat the first page (1-based paging); any later repeat means no progress.
    if (fresh === 0 && page !== undefined && page > 1) return { items, requests, stop: "no-progress" };
  }
}

async function listAllPages(
  client: DubberApi,
  accountId: string,
  user: string | undefined,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const limit = optionalIntegerInRange(args, "limit", 1, DUB_POINTS_MAX_LIMIT) ?? DUB_POINTS_DEFAULT_LIMIT;
  const offset = optionalIntegerInRange(args, "offset", 0, DUB_POINTS_MAX_LIMIT) ?? 0;
  // One extra item tells whether more exist past this window.
  const walk = await walkDubPoints(client, accountId, user, offset + limit + 1);
  const window = walk.items.slice(offset, offset + limit);
  const pastWindow = walk.items.length > offset + limit;
  const incomplete = walk.stop === "cap" || walk.stop === "no-progress" || walk.stop === "rate-limited";
  const hasMore = pastWindow || incomplete;
  const nextOffset = pastWindow || (incomplete && walk.items.length > offset) ? offset + window.length : null;

  let note: string | undefined;
  if (pastWindow) {
    note = `More dub points exist. Call again with offset=${offset + window.length} (same userId and limit) to continue.`;
  } else if (walk.stop === "rate-limited") {
    note =
      `${walk.rateLimit === "daily" ? "Dubber's daily rate limit" : "Dubber's rate limit"} stopped the scan after ` +
      `${walk.requests} requests (${walk.items.length} dub points read). Call again with offset=${offset + window.length} ` +
      (walk.rateLimit === "daily" ? "once the daily quota resets." : "in a few seconds.");
  } else if (walk.stop === "cap") {
    note =
      `Scan cap reached (${walk.requests} Dubber requests, ${walk.items.length} dub points). More may exist: ` +
      `read them one page at a time with count=100 and page=${walk.requests} onward.`;
  } else if (walk.stop === "no-progress") {
    note = "Dubber returned a full page with no new dub points, so paging stopped; the list may be incomplete.";
  } else if (walk.items.length === 0) {
    note = "No Dub.Point connections.";
  } else if (window.length === 0) {
    note = `offset=${offset} is past the end of the list (${walk.items.length} dub points).`;
  }

  const fields = {
    allPages: true,
    hasMore,
    nextOffset,
    offset,
    limit,
    requests: walk.requests,
    scanCapReached: walk.stop === "cap",
    ...(walk.stop === "rate-limited" ? { rateLimited: true } : {}),
    ...(note ? { note } : {}),
  };
  return listResult(fields, "dub_points", window, (kept) => ({
    hasMore: true,
    nextOffset: offset + kept.length,
    note:
      trimNote(kept.length, window.length, `Call again with offset=${offset + kept.length} (same userId) to continue.`) +
      // Keep the reason the scan itself stopped early (cap, rate limit, no progress).
      (incomplete && note ? ` ${note}` : ""),
  }));
}

async function list(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const user = args["userId"] === undefined || args["userId"] === null ? undefined : requireId(args, "userId");
  const explicitPage = args["page"] !== undefined && args["page"] !== null;
  if (!explicitPage) {
    if (args["count"] !== undefined && args["count"] !== null) {
      throw new ToolInputError('Argument "count" only applies with "page" (one explicit page); use "limit" to cap the all-pages list.');
    }
    return listAllPages(client, accountId, user, args);
  }
  for (const key of ["limit", "offset"]) {
    if (args[key] !== undefined && args[key] !== null) {
      throw new ToolInputError(`Argument "${key}" cannot be combined with "page"; omit "page" to list every page.`);
    }
  }
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
