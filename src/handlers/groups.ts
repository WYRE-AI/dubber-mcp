import type { DubberApi } from "../dubber-api.js";
import { jsonResult, optionalObject, requireId, requireString, type ToolHandler, type ToolResult } from "./results.js";

async function get(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.groups.get(requireId(args, "groupId")));
}

async function createChild(client: DubberApi, args: Record<string, unknown>): Promise<ToolResult> {
  const groupId = requireId(args, "groupId");
  const name = requireString(args, "name");
  return jsonResult(await client.groups.createChild(groupId, { name }));
}

async function listUnidentifiedRecordings(
  client: DubberApi,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const recordings = await client.groups.listUnidentifiedRecordings(requireId(args, "groupId"));
  if (recordings.length === 0) return jsonResult({ recordings: [], note: "No unidentified recordings." });
  return jsonResult(recordings);
}

async function createUnidentifiedRecording(
  client: DubberApi,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const groupId = requireId(args, "groupId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.groups.createUnidentifiedRecording(groupId, data));
}

export const GROUPS_HANDLERS: Record<string, ToolHandler> = {
  dubber_groups_get: get,
  dubber_groups_create_child: createChild,
  dubber_groups_list_unidentified_recordings: listUnidentifiedRecordings,
  dubber_groups_create_unidentified_recording: createUnidentifiedRecording,
};
