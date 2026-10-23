/**
 * dubber_recordings_list: limit/offset/time-window listing on top of Dubber's
 * real paging model (WYREAI-567).
 *
 * Dubber's GET /accounts/:id/recordings has only `count` (max 100), `page`
 * (max 5 pages), the `before_id` cursor and `query`. It has NO limit/offset and
 * NO date filter, and it silently ignores unknown params. So this handler
 * walks the newest-first list with count=100 + before_id and applies
 * offset/limit/time filtering itself.
 */
import type { DubberClient, Recording } from "@wyre-ai/node-dubber";
import {
  jsonResult,
  optionalInteger,
  optionalString,
  requireString,
  ToolInputError,
  type ToolResult,
} from "./results.js";

/** Dubber's maximum `count` per request. */
export const DUBBER_PAGE_SIZE = 100;
/** Hard cap on Dubber requests per tool call (25 * 100 = 2,500 recordings scanned). */
export const MAX_REQUESTS_PER_CALL = 25;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

/** The documented Dubber query params for this endpoint that we send. */
export interface RecordingsPageParams {
  count: number;
  before_id?: string;
  query?: string;
  dub_point?: string;
  team?: string;
}

/**
 * The single place that talks to the SDK's recordings.list.
 *
 * @wyre-ai/node-dubber 1.0.0 types `list` params as `{ limit?, offset? }`, but
 * its HTTP layer copies every key verbatim into the query string at runtime.
 * We therefore cast ONCE here to send Dubber's real params. Once the node-dubber
 * release that types `count`/`before_id`/`query` is adopted, drop the cast and
 * pass `params` directly.
 */
async function fetchRecordingsPage(
  client: DubberClient,
  accountId: string,
  params: RecordingsPageParams
): Promise<Recording[]> {
  const loose = params as unknown as Parameters<DubberClient["recordings"]["list"]>[1];
  return client.recordings.list(accountId, loose);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

interface ParsedBound {
  /** epoch ms of the bound */
  ms: number;
  dateOnly: boolean;
}

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
        `(2026-10-19T09:00:00+10:00); got "${raw}".`
    );
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    if (!validYmd(y, m, d)) throw bad();
    return { ms: Date.UTC(y, m - 1, d), dateOnly: true };
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
  return { ms: Date.UTC(y, m - 1, d, hh, mm, ss) + Math.floor(ms) - offsetMin * 60_000, dateOnly: false };
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

export async function listRecordings(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireString(args, "accountId");
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
  const query = optionalString(args, "query")?.trim() || undefined;
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

  paging: for (;;) {
    const params: RecordingsPageParams = { count: DUBBER_PAGE_SIZE };
    if (beforeId !== undefined) params.before_id = beforeId;
    if (query !== undefined) params.query = query;
    if (dubPointId !== undefined) params.dub_point = dubPointId;
    if (teamId !== undefined) params.team = teamId;
    const page = await fetchRecordingsPage(client, accountId, params);
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
    if (pageAllBeforeFrom) break; // everything further back is older than startTimeFrom
    if (requests >= MAX_REQUESTS_PER_CALL) {
      scanCapReached = true;
      hasMore = true;
      nextCursor = lastId;
      break;
    }
    beforeId = lastId;
  }

  let note: string | undefined;
  if (scanCapReached) {
    note =
      `Scan cap reached (${requests} Dubber requests, ${scanned} recordings examined) before the limit was met. ` +
      `Call again with cursor="${nextCursor}" and offset=0 (same filters) to continue.`;
  } else if (hasMore) {
    note = `More recordings may exist. Call again with cursor="${nextCursor}" and offset=0 (same filters) to continue.`;
  } else if (recordings.length === 0) {
    note = "No recordings found.";
  }
  if (timeFiltered && unparseable > 0) {
    const extra = `${unparseable} examined recording(s) had an unparseable start_time and were excluded by the time filter.`;
    note = note ? `${note} ${extra}` : extra;
  }

  return jsonResult({
    recordings,
    returned: recordings.length,
    hasMore,
    nextCursor,
    scanned,
    requests,
    scanCapReached,
    ...(timeFiltered ? { excludedUnparseableStartTime: unparseable } : {}),
    filters: {
      limit,
      offset,
      cursor: cursor ?? null,
      query: query ?? null,
      dubPointId: dubPointId ?? null,
      teamId: teamId ?? null,
      startTimeFrom: fromMs === undefined ? null : new Date(fromMs).toISOString(),
      startTimeToExclusive: toExclusiveMs === undefined ? null : new Date(toExclusiveMs).toISOString(),
    },
    ...(note ? { note } : {}),
  });
}
