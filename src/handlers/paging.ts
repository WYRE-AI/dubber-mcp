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
    note: trimNote(kept.length, total, rereadGuidance(kept.length, count, page)),
  }));
}

/**
 * How to recover the trimmed tail of one page without skipping or repeating items.
 * Dubber pages are `count`-sized blocks, so a smaller count must keep the same start offset:
 * with a divisor `c` of `count`, the original page becomes `count / c` consecutive pages of
 * size `c`. Dubber does not document whether pages start at 0 or 1, so both numberings are given.
 */
export function rereadGuidance(kept: number, count: number, page: number | undefined): string {
  let c = 1;
  for (let d = Math.min(kept, count); d >= 1; d--) {
    if (count % d === 0) {
      c = d;
      break;
    }
  }
  const per = count / c;
  // An omitted page is the first page under either numbering.
  const zeroStart = (page ?? 0) * per;
  const oneStart = page === undefined ? 1 : page >= 1 ? (page - 1) * per + 1 : undefined;
  const span = (start: number) => (per === 1 ? `page=${start}` : `page=${start} through page=${start + per - 1}`);
  return (
    "Do not move on to the next page yet, or the dropped items are skipped. Re-read this page's items with " +
    `count=${c} (it divides ${count}, so the start offset is unchanged): ${span(zeroStart)} if Dubber pages start at 0` +
    (oneStart === undefined ? "" : `, or ${span(oneStart)} if they start at 1`) +
    `. Then continue with count=${c} from the page after that, skipping ids you already have.`
  );
}

/** An unpaged Dubber list: `{ returned, note?, <key>: items }`, trimmed from the end if too long. */
export function unpagedListResult(key: string, items: unknown[], emptyNote: string, narrow: string): ToolResult {
  return listResult(items.length === 0 ? { note: emptyNote } : {}, key, items, (kept, total) => ({
    note: trimNote(kept.length, total, narrow),
  }));
}
