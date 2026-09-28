import type { DubberClient } from "@wyre-ai/node-dubber";
import { confirmDestructive, type ElicitationContext } from "../elicitation.js";
import {
  errorResult,
  jsonResult,
  optionalInteger,
  optionalObject,
  requireObject,
  requireString,
  requireStringArray,
  textResult,
  type ToolHandler,
  type ToolResult,
} from "./results.js";

const CANCELLED = "Cancelled — nothing was changed.";

async function list(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireString(args, "accountId");
  const limit = optionalInteger(args, "limit");
  const offset = optionalInteger(args, "offset");
  const recordings = await client.recordings.list(accountId, { limit, offset });
  if (recordings.length === 0) return jsonResult({ recordings: [], note: "No recordings found." });
  return jsonResult(recordings);
}

async function create(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireString(args, "accountId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.recordings.create(accountId, data));
}

async function get(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.get(requireString(args, "recordingId")));
}

async function getWaveform(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.getWaveform(requireString(args, "recordingId")));
}

async function deleteRecording(
  client: DubberClient,
  args: Record<string, unknown>,
  elicitation: ElicitationContext
) {
  const recordingId = requireString(args, "recordingId");
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

async function updateMetadata(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const recordingId = requireString(args, "recordingId");
  const metadata = requireObject(args, "metadata");
  return jsonResult(await client.recordings.updateMetadata(recordingId, metadata));
}

async function addTags(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const recordingId = requireString(args, "recordingId");
  const tags = requireStringArray(args, "tags");
  return jsonResult(await client.recordings.addTags(recordingId, tags));
}

async function deleteTags(
  client: DubberClient,
  args: Record<string, unknown>,
  elicitation: ElicitationContext
) {
  const recordingId = requireString(args, "recordingId");
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

async function initiateMultipartUpload(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = requireString(args, "accountId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.recordings.initiateMultipart(accountId, data));
}

async function getUploadTarget(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.getUploadTarget(requireString(args, "recordingId")));
}

async function completeUpload(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.recordings.completeUpload(requireString(args, "recordingId")));
}

export const RECORDINGS_HANDLERS: Record<string, ToolHandler> = {
  dubber_recordings_list: list,
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
