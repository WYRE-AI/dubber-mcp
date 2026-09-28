import type { DubberClient } from "@wyre-ai/node-dubber";
import { jsonResult, optionalObject, requireString, type ToolHandler, type ToolResult } from "./results.js";

async function get(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  return jsonResult(await client.groups.get(requireString(args, "groupId")));
}

async function createChild(client: DubberClient, args: Record<string, unknown>): Promise<ToolResult> {
  const groupId = requireString(args, "groupId");
  const name = requireString(args, "name");
  return jsonResult(await client.groups.createChild(groupId, { name }));
}

async function listUnidentifiedRecordings(
  client: DubberClient,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const recordings = await client.groups.listUnidentifiedRecordings(requireString(args, "groupId"));
  if (recordings.length === 0) return jsonResult({ recordings: [], note: "No unidentified recordings." });
  return jsonResult(recordings);
}

async function createUnidentifiedRecording(
  client: DubberClient,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const groupId = requireString(args, "groupId");
  const data = optionalObject(args, "data") ?? {};
  return jsonResult(await client.groups.createUnidentifiedRecording(groupId, data));
}

export const GROUPS_HANDLERS: Record<string, ToolHandler> = {
  dubber_groups_get: get,
  dubber_groups_create_child: createChild,
  dubber_groups_list_unidentified_recordings: listUnidentifiedRecordings,
  dubber_groups_create_unidentified_recording: createUnidentifiedRecording,
};
