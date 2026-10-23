/** Tools 9–17: call recordings — CRUD, tags/metadata, waveform, and multipart upload. */
import type { Tool } from "@modelcontextprotocol/server";
import { CONFIRM_ARG_PROPERTY } from "../elicitation.js";

export const RECORDINGS_TOOLS: Tool[] = [
  {
    name: "dubber_recordings_list",
    description:
      "List call recordings for a Dubber account, NEWEST FIRST. `limit` (default 100, max 500) is the max " +
      "matching recordings to return; `offset` skips that many matching recordings from the newest. " +
      "If the result has hasMore=true, call again with cursor=<nextCursor> and offset=0 (same filters) to " +
      "continue with no gaps or duplicates. Dubber has NO date filter: startTimeFrom/startTimeTo are " +
      "applied by this server after fetching pages (each tool call scans at most 2,500 recordings / 25 " +
      "Dubber requests; scanCapReached=true means continue with nextCursor). startTimeFrom is inclusive; " +
      "startTimeTo is EXCLUSIVE for date-times, but a date-only startTimeTo includes that whole day. " +
      "Dates without an offset are UTC, so pass explicit offsets for local weeks. Example, Mon–Fri week " +
      "in Melbourne daylight time (AEDT, +11:00): startTimeFrom=2026-10-19T00:00:00+11:00, startTimeTo=2026-10-24T00:00:00+11:00, limit=500 " +
      "(or in UTC: startTimeFrom=2026-10-19, startTimeTo=2026-10-23).",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          default: 100,
          description: "Max matching recordings to return (1-500, default 100).",
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
            "Use with offset=0 and the same filters.",
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
        query: { type: "string", description: "Search string passed to Dubber's `query` parameter." },
      },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_recordings_create",
    description:
      "Upload/create a single-shot call recording under a Dubber account. For large files, " +
      "use the multipart tools instead (dubber_recordings_initiate_multipart_upload, " +
      "dubber_recordings_get_upload_target, dubber_recordings_complete_upload).",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        data: { type: "object", description: "Recording fields as accepted by the Dubber API." },
      },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_recordings_get",
    description: "Get a recording's details (metadata, tags, duration) by ID.",
    inputSchema: {
      type: "object",
      properties: { recordingId: { type: "string", description: "Dubber recording ID." } },
      required: ["recordingId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_recordings_get_waveform",
    description: "Get waveform data for a recording, for audio visualization.",
    inputSchema: {
      type: "object",
      properties: { recordingId: { type: "string", description: "Dubber recording ID." } },
      required: ["recordingId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_recordings_delete",
    description:
      "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a call recording. This action " +
      "cannot be undone — the audio and its compliance record are gone. " +
      "Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "Dubber recording ID." },
        ...CONFIRM_ARG_PROPERTY,
      },
      required: ["recordingId"],
    },
    annotations: {
      title: "Delete recording (irreversible)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "dubber_recordings_update_metadata",
    description: "Replace/update a recording's custom metadata fields.",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "Dubber recording ID." },
        metadata: { type: "object", description: "Metadata fields to set." },
      },
      required: ["recordingId", "metadata"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_recordings_add_tags",
    description: "Add one or more tags to a recording (e.g. for compliance categorization).",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "Dubber recording ID." },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add." },
      },
      required: ["recordingId", "tags"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_recordings_delete_tags",
    description:
      "⚠ HIGH-IMPACT. Removes one or more tags from a recording. Reversible by re-adding " +
      "the tags, but any automation keyed on their presence may act in the meantime. " +
      "Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        recordingId: { type: "string", description: "Dubber recording ID." },
        tags: { type: "array", items: { type: "string" }, description: "Tags to remove." },
        ...CONFIRM_ARG_PROPERTY,
      },
      required: ["recordingId", "tags"],
    },
    annotations: {
      title: "Remove recording tags",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "dubber_recordings_initiate_multipart_upload",
    description:
      "Start a multipart (chunked) recording upload for large audio files. Follow with " +
      "dubber_recordings_get_upload_target to get the part-upload URL, then " +
      "dubber_recordings_complete_upload once all parts are sent.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Dubber account ID." },
        data: { type: "object", description: "Recording fields as accepted by the Dubber API." },
      },
      required: ["accountId"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "dubber_recordings_get_upload_target",
    description: "Get the upload target/URL for a multipart recording upload in progress.",
    inputSchema: {
      type: "object",
      properties: { recordingId: { type: "string", description: "Dubber recording ID from the initiate step." } },
      required: ["recordingId"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "dubber_recordings_complete_upload",
    description: "Mark a multipart recording upload complete once all parts have been sent.",
    inputSchema: {
      type: "object",
      properties: { recordingId: { type: "string", description: "Dubber recording ID from the initiate step." } },
      required: ["recordingId"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];
