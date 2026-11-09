import type { DubberApi } from "../dubber-api.js";
import { confirmDestructive, type ElicitationContext } from "../elicitation.js";
import { listRecordings } from "./recordings-list.js";
import {
  errorResult,
  jsonResult,
  optionalObject,
  optionalString,
  requireId,
  requireObject,
  requireStringArray,
  textResult,
  ToolInputError,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

const CANCELLED = "Cancelled — nothing was changed.";

async function create(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.recordings.create(accountId, data));
}

const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Dubber's documented values; only mp3 filenames are supported. Same rule node-dubber enforces. */
const CONTENT_DISPOSITION_RE = /^(inline|attachment|attachment;filename=[^;\r\n"\\/]+\.mp3)$/;

/**
 * Recording details. With `listener`, Dubber also returns `recording_url`, a
 * pre-signed S3 link to the audio: a bearer secret until it expires. It is
 * returned to the caller only; it is never logged (logger redacts signed-URL
 * signatures) and never cached.
 */
async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const recordingId = requireId(args, "recordingId");
  const listener = optionalString(args, "listener")?.trim() || undefined;
  const contentDisposition = optionalString(args, "contentDisposition")?.trim() || undefined;
  if (listener !== undefined && (listener.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(listener))) {
    throw new ToolInputError('Argument "listener" must be the email address of a Dubber user who can access the recording.');
  }
  if (contentDisposition !== undefined) {
    if (listener === undefined) {
      throw new ToolInputError('Argument "contentDisposition" only applies to the recording link; pass "listener" too.');
    }
    if (!CONTENT_DISPOSITION_RE.test(contentDisposition)) {
      throw new ToolInputError(
        'Argument "contentDisposition" must be "inline", "attachment", or "attachment;filename=<name>.mp3".'
      );
    }
  }
  if (listener === undefined) return jsonResult(await client.recordings.get(recordingId));
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

async function deleteRecording(
  client: DubberApi,
  args: Record<string, unknown>,
  elicitation: ElicitationContext
) {
  const recordingId = requireId(args, "recordingId");
  const gate = confirmDestructive(
    elicitation,
    args,
    `Permanently delete recording ${recordingId}? This cannot be undone.`
  );
  if (gate.kind === "ask") return gate.result;
  if (gate.kind === "blocked") return errorResult(gate.message);
  if (gate.kind === "refused") return textResult(CANCELLED);

  await client.recordings.delete(recordingId);
  return textResult(`Recording ${recordingId} deleted.`);
}

async function updateMetadata(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const recordingId = requireId(args, "recordingId");
  const metadata = requireObject(args, "metadata");
  return jsonResult(await client.recordings.updateMetadata(recordingId, metadata));
}

async function addTags(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const recordingId = requireId(args, "recordingId");
  const tags = requireStringArray(args, "tags");
  return jsonResult(await client.recordings.addTags(recordingId, tags));
}

async function deleteTags(
  client: DubberApi,
  args: Record<string, unknown>,
  elicitation: ElicitationContext
) {
  const recordingId = requireId(args, "recordingId");
  const tags = requireStringArray(args, "tags");
  const gate = confirmDestructive(
    elicitation,
    args,
    `Remove tags [${tags.join(", ")}] from recording ${recordingId}?`
  );
  if (gate.kind === "ask") return gate.result;
  if (gate.kind === "blocked") return errorResult(gate.message);
  if (gate.kind === "refused") return textResult(CANCELLED);

  return jsonResult(await client.recordings.deleteTags(recordingId, tags));
}

async function initiateMultipartUpload(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireId(args, "accountId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.recordings.initiateMultipart(accountId, data));
}

async function getUploadTarget(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.getUploadTarget(requireId(args, "recordingId")));
}

async function completeUpload(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.completeUpload(requireId(args, "recordingId")));
}

export const RECORDINGS_HANDLERS: Record<string, ToolHandler> = {
  dubber_recordings_list: listRecordings,
  dubber_recordings_create: create,
  dubber_recordings_get: get,
  dubber_recordings_get_waveform: getWaveform,
  dubber_recordings_delete: deleteRecording,
  dubber_recordings_update_metadata: updateMetadata,
  dubber_recordings_add_tags: addTags,
  dubber_recordings_delete_tags: deleteTags,
  dubber_recordings_initiate_multipart_upload: initiateMultipartUpload,
  dubber_recordings_get_upload_target: getUploadTarget,
  dubber_recordings_complete_upload: completeUpload,
};
