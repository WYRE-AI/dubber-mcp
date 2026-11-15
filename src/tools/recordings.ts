/** Tools: read call recordings: list, details, the signed audio link, waveform. */
import type { Tool } from "@modelcontextprotocol/server";
import { MAX_RESPONSE_CHARS } from "../config.js";
import { MAX_LIMIT, MAX_REQUESTS_PER_CALL, DUBBER_PAGE_SIZE } from "../handlers/recordings-list.js";

const MAX_SCANNED = MAX_REQUESTS_PER_CALL * DUBBER_PAGE_SIZE;

export const RECORDINGS_TOOLS: Tool[] = [
  {
    name: "dubber_recordings_list",
    description:
      "List call recordings for a Dubber account, NEWEST FIRST (as Dubber returns them; its docs do not state " +
      "the sort key, so with startTimeFrom the scan stops at a full page older than it and the note gives a " +
      `cursor to check further back). \`limit\` (default 100, max ${MAX_LIMIT}) is the max ` +
      "matching recordings to return; `offset` skips that many matching recordings from the newest. " +
      "If the result has hasMore=true, call again with cursor=<nextCursor> and offset=<remainingOffset> (same filters; " +
      "remainingOffset is 0 unless the call stopped while still skipping) to continue with no gaps or duplicates. " +
      `A result is at most ${MAX_RESPONSE_CHARS.toLocaleString("en-US")} characters: a longer one returns fewer than limit ` +
      "recordings with hasMore=true and a nextCursor after the last one returned. " +
      "Dubber has NO date filter: startTimeFrom/startTimeTo are " +
      `applied by this server after fetching pages (each tool call scans at most ${MAX_SCANNED.toLocaleString("en-US")} ` +
      `recordings / ${MAX_REQUESTS_PER_CALL} Dubber requests; scanCapReached=true means continue with nextCursor; ` +
      "rateLimited=true means Dubber's rate limit stopped the scan early, so wait a few seconds and continue with " +
      "nextCursor, or, if the note says daily, wait for the daily quota reset). startTimeFrom is inclusive; " +
      "startTimeTo is EXCLUSIVE for date-times, but a date-only startTimeTo includes that whole day. " +
      "Dates without an offset are UTC, so pass explicit offsets for local weeks. Example, Mon–Fri week " +
      "in Melbourne daylight time (AEDT, +11:00): startTimeFrom=2026-10-19T00:00:00+11:00, startTimeTo=2026-10-24T00:00:00+11:00, limit=500 " +
      "(or in UTC: startTimeFrom=2026-10-19, startTimeTo=2026-10-23). " +
      "Scope to ONE dub point (dubPointId) or ONE team (teamId), never both: Dubber has no direct user filter " +
      "on recordings. To get one technician's week, find their dub point id(s) with dubber_dub_points_list " +
      "(pass userId), then call once per dub point. " +
      "A cursor must be reused with the SAME dubPointId/teamId.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: 100,
          description: `Max matching recordings to return (1-${MAX_LIMIT}, default 100).`,
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Number of matching recordings (newest first) to skip before collecting. Default 0.",
        },
        cursor: {
          type: "string",
          description:
            "Continue from a previous result's nextCursor (a Dubber recording id used as before_id). " +
            "Use with offset=remainingOffset from that result and the same filters.",
        },
        startTimeFrom: {
          type: "string",
          description:
            "ISO 8601 date or date-time; keep recordings whose start_time is at or after this (inclusive). " +
            "No offset = UTC. Filtered server-side after fetching.",
        },
        startTimeTo: {
          type: "string",
          description:
            "ISO 8601 date or date-time; keep recordings whose start_time is before this (exclusive). " +
            "A date-only value includes that entire day (UTC). Filtered server-side after fetching.",
        },
        dubPointId: {
          type: "string",
          description:
            "Only recordings for this dub point (Dubber `dub_point`). One dub point per call; cannot be " +
            "combined with teamId. Get ids from dubber_dub_points_list. Reuse the same value with a cursor.",
        },
        teamId: {
          type: "string",
          description:
            "Only recordings for dub points in this team (Dubber `team`). One team per call; cannot be " +
            "combined with dubPointId. Reuse the same value with a cursor.",
        },
      },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_recordings_get",
    description:
      "Get a recording's details (from/to, call type, channel, status, start/end time, duration) by ID. " +
      "Does not return an audio link; use " +
      "dubber_recordings_get_link for that.",
    inputSchema: {
      type: "object",
      properties: { recordingId: { type: "string", description: "Dubber recording ID." } },
      required: ["recordingId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_recordings_get_link",
    description:
      "Get a recording's details plus `recording_url`, a pre-signed link to the MP3 audio, issued for `listener` " +
      "(the email of the Dubber user who will listen). Dubber checks that this user can access the recording and " +
      "may attribute the access to them in its audit trail, so pass ONLY the email of the person who asked for the " +
      "link, never someone else's. The link is a bearer credential: anyone holding it can download the call audio " +
      "until it expires (its Expires query parameter is a Unix timestamp). Share it only with that person; this " +
      "server never logs or caches it.",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "Dubber recording ID." },
        listener: {
          type: "string",
          description: "Email of the Dubber user requesting the link; that user must be able to access the recording.",
        },
        contentDisposition: {
          type: "string",
          description:
            'How the link downloads: "inline", "attachment", or "attachment;filename=<name>.mp3" (mp3 only).',
        },
      },
      required: ["recordingId", "listener"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_recordings_get_waveform",
    description:
      "Get a recording's waveform: `waveform_url`, a short-lived (about 5 minutes) pre-signed link to the " +
      "waveform .dat file, for audio visualization. The link is a bearer credential; do not share it.",
    inputSchema: {
      type: "object",
      properties: { recordingId: { type: "string", description: "Dubber recording ID." } },
      required: ["recordingId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
