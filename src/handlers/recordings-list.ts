/**
 * dubber_recordings_list: limit/offset/time-window listing on top of Dubber's
 * real paging model (WYREAI-567).
 *
 * Get_Account_Recordings documents only `count` (max 100), `page`, the
 * `before_id` cursor, `dub_point` and `team`. It has NO limit/offset and NO
 * date filter, and it silently ignores unknown params (so an undocumented
 * `query` is not offered: an ignored filter would return every recording).
 * This handler walks the newest-first list with count=100 + before_id and
 * applies offset/limit/time filtering itself.
 *
 * Dubber rate-limits with 403 (codes 1021/1022/1024). A rate limit after the
 * first page ends the scan early and returns what was collected plus a
 * cursor, so the caller can resume instead of losing the pages already read.
 */
import type { Recording } from "@wyre-ai/node-dubber";
import { rateLimitOf, type DubberApi } from "../dubber-api.js";
import {
  listResult,
  optionalInteger,
  optionalString,
  requireId,
  ToolInputError,
  trimNote,
  type ToolResult,
} from "./results.js";

/** Dubber's maximum `count` per request. */
export const DUBBER_PAGE_SIZE = 100;
/** Hard cap on Dubber requests per tool call (10 * 100 = 1,000 recordings scanned). */
export const MAX_REQUESTS_PER_CALL = 10;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

/** The documented Dubber query params for this endpoint that we send. */
export interface RecordingsPageParams {
  count: number;
  before_id?: string;
  dub_point?: string;
  team?: string;
}

/** The single place that talks to the SDK's recordings.list (node-dubber >= 1.1.0 types Dubber's real params). */
async function fetchRecordingsPage(
  client: DubberApi,
  accountId: string,
  params: RecordingsPageParams
): Promise<Recording[]> {
  return client.recordings.list(accountId, params);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

interface ParsedBound {
  /** epoch ms of the bound */
  ms: number;
  dateOnly: boolean;
  /** No UTC offset was given (a date-only bound, or a date-time without Z or +hh:mm), so UTC was assumed. */
  assumedUtc: boolean;
}

const ASSUMED_UTC_NOTE =
  "startTimeFrom/startTimeTo had no UTC offset and were interpreted as UTC (see filters); " +
  "pass an explicit offset such as +11:00 for a local-time window.";

/** True when y-m-d is a real calendar date (rejects 2026-02-31). */
function validYmd(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse an ISO 8601 date or date-time. No offset means UTC. Throws ToolInputError. */
function parseBound(key: string, raw: string): ParsedBound {
  const value = raw.trim();
  const bad = () =>
    new ToolInputError(
      `Argument "${key}" must be an ISO 8601 date (2026-10-19) or date-time ` +
        `(2026-10-19T09:00:00+11:00); got "${raw}".`
    );
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    if (!validYmd(y, m, d)) throw bad();
    return { ms: Date.UTC(y, m - 1, d), dateOnly: true, assumedUtc: true };
  }
  const dt = DATE_TIME.exec(value);
  if (!dt) throw bad();
  const [y, m, d, hh, mm] = [dt[1], dt[2], dt[3], dt[4], dt[5]].map(Number) as [number, number, number, number, number];
  const ss = dt[6] === undefined ? 0 : Number(dt[6]);
  if (!validYmd(y, m, d) || hh > 23 || mm > 59 || ss > 59) throw bad();
  let offsetMin = 0;
  const zone = dt[7];
  if (zone && zone.toUpperCase() !== "Z") {
    const digits = zone.replace(":", "");
    const oh = Number(digits.slice(1, 3));
    const om = Number(digits.slice(3, 5));
    if (oh > 23 || om > 59) throw bad();
    offsetMin = (digits[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const fractional = /\.(\d{1,9})/.exec(value)?.[1];
  const ms = fractional ? Number(`0.${fractional}`) * 1000 : 0;
  return {
    ms: Date.UTC(y, m - 1, d, hh, mm, ss) + Math.floor(ms) - offsetMin * 60_000,
    dateOnly: false,
    assumedUtc: zone === undefined,
  };
}

/** Recording start_time (RFC 2822, e.g. "Sun, 28 Jul 2013 12:42:10 +1000") -> epoch ms, or undefined. */
export function parseStartTime(recording: Recording): number | undefined {
  const raw = recording["start_time"];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const ms = Date.parse(raw.trim());
  return Number.isNaN(ms) ? undefined : ms;
}

function intInRange(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number
): number {
  const value = optionalInteger(args, key);
  if (value === undefined) return fallback;
  if (value < min || value > max) {
    throw new ToolInputError(
      `Argument "${key}" must be an integer between ${min} and ${max === Infinity ? "infinity" : max}; got ${value}.`
    );
  }
  return value;
}

/** Optional non-empty string arg, trimmed. Empty/blank strings are rejected. */
function optionalId(args: Record<string, unknown>, key: string): string | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  const raw = optionalString(args, key);
  if (raw === undefined || raw.trim() === "") {
    throw new ToolInputError(`Argument "${key}" must be a non-empty string when provided.`);
  }
  return raw.trim();
}

export async function listRecordings(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  if (args["query"] !== undefined) {
    throw new ToolInputError(
      'Argument "query" was removed: Dubber has no text search on recordings, so it would be silently ignored and ' +
        "every recording returned. Filter with dubPointId, teamId, startTimeFrom and startTimeTo instead."
    );
  }
  const accountId = requireId(args, "accountId");
  const limit = intInRange(args, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = intInRange(args, "offset", 0, Number.MAX_SAFE_INTEGER, 0);

  let cursor: string | undefined;
  if (args["cursor"] !== undefined && args["cursor"] !== null) {
    const raw = optionalString(args, "cursor");
    if (raw === undefined || raw.trim() === "") {
      throw new ToolInputError('Argument "cursor" must be a non-empty string (use the previous result\'s nextCursor).');
    }
    cursor = raw.trim();
  }
  const dubPointId = optionalId(args, "dubPointId");
  const teamId = optionalId(args, "teamId");
  if (dubPointId !== undefined && teamId !== undefined) {
    throw new ToolInputError(
      'Arguments "dubPointId" and "teamId" cannot be combined (Dubber forbids dub_point with team); pass one.'
    );
  }

  const fromRaw = optionalString(args, "startTimeFrom");
  const toRaw = optionalString(args, "startTimeTo");
  const from = fromRaw === undefined ? undefined : parseBound("startTimeFrom", fromRaw);
  const to = toRaw === undefined ? undefined : parseBound("startTimeTo", toRaw);
  // Inclusive lower bound; exclusive upper bound. A date-only upper bound
  // names a whole day, so it becomes the start of the NEXT day (exclusive).
  const fromMs = from?.ms;
  const toExclusiveMs = to === undefined ? undefined : to.dateOnly ? to.ms + 86_400_000 : to.ms;
  if (fromMs !== undefined && toExclusiveMs !== undefined && fromMs >= toExclusiveMs) {
    throw new ToolInputError(
      `startTimeFrom (${fromRaw}) must be earlier than startTimeTo (${toRaw}).`
    );
  }
  const timeFiltered = fromMs !== undefined || toExclusiveMs !== undefined;

  const recordings: Recording[] = [];
  let toSkip = offset;
  let scanned = 0;
  let requests = 0;
  let unparseable = 0;
  let beforeId = cursor;
  let hasMore = false;
  let nextCursor: string | null = null;
  let scanCapReached = false;
  let rateLimited: string | undefined;
  let stoppedOlderAt: string | undefined;

  paging: for (;;) {
    const params: RecordingsPageParams = { count: DUBBER_PAGE_SIZE };
    if (beforeId !== undefined) params.before_id = beforeId;
    if (dubPointId !== undefined) params.dub_point = dubPointId;
    if (teamId !== undefined) params.team = teamId;
    let page: Recording[];
    try {
      page = await fetchRecordingsPage(client, accountId, params);
    } catch (error) {
      const rateLimit = rateLimitOf(error);
      // Nothing read yet: report the error. Otherwise keep what was read and hand back a cursor.
      if (!rateLimit || requests === 0) throw error;
      rateLimited = rateLimit.kind === "daily" ? "Dubber's daily rate limit" : "Dubber's rate limit";
      hasMore = true;
      nextCursor = beforeId ?? null;
      break;
    }
    requests += 1;
    if (page.length === 0) break;

    let pageAllBeforeFrom = fromMs !== undefined;
    for (let i = 0; i < page.length; i++) {
      const rec = page[i]!;
      scanned += 1;
      const start = parseStartTime(rec);
      if (pageAllBeforeFrom && !(start !== undefined && start < fromMs!)) pageAllBeforeFrom = false;

      let matches = true;
      if (timeFiltered) {
        if (start === undefined) {
          unparseable += 1;
          matches = false;
        } else if ((fromMs !== undefined && start < fromMs) || (toExclusiveMs !== undefined && start >= toExclusiveMs)) {
          matches = false;
        }
      }
      if (!matches) continue;
      if (toSkip > 0) {
        toSkip -= 1;
        continue;
      }
      recordings.push(rec);
      if (recordings.length >= limit) {
        // Stopped after examining rec: resuming from rec.id loses nothing.
        // More exists unless this was the final record of a short (last) page.
        const lastOfPage = i === page.length - 1;
        hasMore = !(lastOfPage && page.length < DUBBER_PAGE_SIZE);
        nextCursor = hasMore ? rec.id : null;
        break paging;
      }
    }

    const lastId = page[page.length - 1]!.id;
    if (page.length < DUBBER_PAGE_SIZE) break; // end of data
    if (typeof lastId !== "string" || lastId === "") {
      throw new Error("Dubber returned a recording without an id, so the list cannot be paged further.");
    }
    if (pageAllBeforeFrom) {
      // Everything further back is older than startTimeFrom, IF Dubber lists newest first by
      // start_time. Its docs do not state the order, so the note offers a cursor to check.
      stoppedOlderAt = lastId;
      break;
    }
    if (requests >= MAX_REQUESTS_PER_CALL) {
      scanCapReached = true;
      hasMore = true;
      nextCursor = lastId;
      break;
    }
    beforeId = lastId;
  }

  let note: string | undefined;
  if (rateLimited) {
    note =
      `${rateLimited} stopped the scan after ${requests} Dubber requests. ` +
      `Call again with cursor="${nextCursor}" and offset=${toSkip} (same filters) to continue` +
      (rateLimited.includes("daily") ? " once the daily quota resets." : " in a few seconds.");
  } else if (scanCapReached) {
    note =
      `Scan cap reached (${requests} Dubber requests, ${scanned} recordings examined) before the limit was met. ` +
      `Call again with cursor="${nextCursor}" and offset=${toSkip} (same filters) to continue.`;
  } else if (hasMore) {
    note = `More recordings may exist. Call again with cursor="${nextCursor}" and offset=${toSkip} (same filters) to continue.`;
  } else if (recordings.length === 0) {
    note = "No recordings found.";
  }
  if (stoppedOlderAt !== undefined) {
    const extra =
      "Stopped at a full page of recordings all older than startTimeFrom, assuming Dubber lists newest first " +
      "by start_time (its docs do not state the order). To check further back anyway, call again with " +
      `cursor="${stoppedOlderAt}" and offset=${toSkip} (same filters).`;
    note = note ? `${note} ${extra}` : extra;
  }
  if (timeFiltered && unparseable > 0) {
    const extra = `${unparseable} examined recording(s) had an unparseable start_time and were excluded by the time filter.`;
    note = note ? `${note} ${extra}` : extra;
  }
  const assumedUtc = from?.assumedUtc === true || to?.assumedUtc === true;
  if (assumedUtc) note = note ? `${note} ${ASSUMED_UTC_NOTE}` : ASSUMED_UTC_NOTE;

  const fields = {
    hasMore,
    nextCursor,
    remainingOffset: toSkip,
    scanned,
    requests,
    scanCapReached,
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(timeFiltered ? { excludedUnparseableStartTime: unparseable } : {}),
    filters: {
      limit,
      offset,
      cursor: cursor ?? null,
      dubPointId: dubPointId ?? null,
      teamId: teamId ?? null,
      startTimeFrom: fromMs === undefined ? null : new Date(fromMs).toISOString(),
      startTimeToExclusive: toExclusiveMs === undefined ? null : new Date(toExclusiveMs).toISOString(),
    },
    ...(note ? { note } : {}),
  };
  // Too long for one result: keep the newest recordings and resume after the last one kept.
  return listResult(fields, "recordings", recordings, (kept, total) => {
    const cursor = (kept[kept.length - 1] as Recording).id;
    const trimmed = trimNote(kept.length, total, `Call again with cursor="${cursor}" and offset=0 (same filters) to continue.`);
    return {
      hasMore: true,
      nextCursor: cursor,
      remainingOffset: 0,
      note: assumedUtc ? `${trimmed} ${ASSUMED_UTC_NOTE}` : trimmed,
    };
  });
}
