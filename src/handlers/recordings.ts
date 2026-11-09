import type { DubberApi } from "../dubber-api.js";
import { listRecordings } from "./recordings-list.js";
import {
  jsonResult,
  optionalString,
  requireId,
  requireString,
  ToolInputError,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.get(requireId(args, "recordingId")));
}

const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Dubber's documented values; only mp3 filenames are supported. Same rule node-dubber enforces. */
const CONTENT_DISPOSITION_RE = /^(inline|attachment|attachment;filename=[^;\r\n"\\/]+\.mp3)$/;

/**
 * Get Recording Link: recording details plus `recording_url`, a pre-signed
 * S3 link to the audio and a bearer secret until it expires. Its own tool so
 * Conduit can enable it separately from plain reads. Returned to the caller
 * only; never logged (the logger strips signed-URL signatures) or cached.
 */
async function getLink(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const recordingId = requireId(args, "recordingId");
  const listener = requireString(args, "listener").trim();
  const contentDisposition = optionalString(args, "contentDisposition")?.trim() || undefined;
  if (listener.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(listener)) {
    throw new ToolInputError('Argument "listener" must be the email address of a Dubber user who can access the recording.');
  }
  if (contentDisposition !== undefined && !CONTENT_DISPOSITION_RE.test(contentDisposition)) {
    throw new ToolInputError(
      'Argument "contentDisposition" must be "inline", "attachment", or "attachment;filename=<name>.mp3".'
    );
  }
  return jsonResult(
    await client.recordings.get(recordingId, {
      listener,
      ...(contentDisposition ? { content_disposition: contentDisposition } : {}),
    })
  );
}

async function getWaveform(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.getWaveform(requireId(args, "recordingId")));
}

export const RECORDINGS_HANDLERS: Record<string, ToolHandler> = {
  dubber_recordings_list: listRecordings,
  dubber_recordings_get: get,
  dubber_recordings_get_link: getLink,
  dubber_recordings_get_waveform: getWaveform,
};
