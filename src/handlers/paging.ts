/**
 * One explicit page of a Dubber list endpoint that pages with `count`
 * (default 20, max 100) and `page`. Dubber silently stops at `count`, so the
 * result always says whether a full page came back (more may exist).
 */
import { listResult, optionalIntegerInRange, trimNote, type ToolResult } from "./results.js";

export const MAX_PAGE_COUNT = 100;

export interface PageArgs {
  count: number;
  page?: number;
}

export function pageArgs(args: Record<string, unknown>): PageArgs {
  const count = optionalIntegerInRange(args, "count", 1, MAX_PAGE_COUNT) ?? MAX_PAGE_COUNT;
  const page = optionalIntegerInRange(args, "page", 0, Number.MAX_SAFE_INTEGER);
  return page === undefined ? { count } : { count, page };
}

/** `{ returned, count, page, hasMore, note?, <key>: items }` */
export function pageResult(key: string, items: unknown[], { count, page }: PageArgs, emptyNote: string): ToolResult {
  const hasMore = items.length >= count;
  const note = hasMore
    ? `A full page came back, so more may exist: call again with page=${page === undefined ? 1 : page + 1} ` +
      "(Dubber does not document whether pages start at 0 or 1; skip ids you already have)."
    : items.length === 0
      ? emptyNote
      : undefined;
  return listResult({ count, page: page ?? null, hasMore, ...(note ? { note } : {}) }, key, items, (kept, total) => ({
    hasMore: true,
    note: trimNote(kept.length, total, `Call again with a smaller count (e.g. count=${kept.length}) to page through the rest.`),
  }));
}

/** An unpaged Dubber list: `{ returned, note?, <key>: items }`, trimmed from the end if too long. */
export function unpagedListResult(key: string, items: unknown[], emptyNote: string, narrow: string): ToolResult {
  return listResult(items.length === 0 ? { note: emptyNote } : {}, key, items, (kept, total) => ({
    note: trimNote(kept.length, total, narrow),
  }));
}
