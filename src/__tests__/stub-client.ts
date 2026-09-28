/**
 * A network-free DubberClient for handler tests. Every SDK method used by
 * the handlers is a vi.fn() with a harmless default, so a test overrides
 * only the calls it cares about:
 *
 *   const client = stubClient({
 *     recordings: { get: vi.fn(async () => RECORDING) },
 *   });
 *   await handleToolCall(client, "dubber_recordings_get", { recordingId: "rec-1" }, NO_ELICITATION);
 *   expect(client.recordings.get).toHaveBeenCalledWith("rec-1");
 *
 * The result is typed as both the mock tree and a DubberClient, so it can be
 * passed to handlers directly and still expose `.mock` for assertions.
 * Build it inside each test: vitest.config.ts sets `mockReset: true`.
 */
import { vi, type Mock } from "vitest";
import type { DubberClient } from "@wyre-ai/node-dubber";

type Methods = Record<string, Mock>;

export interface StubTree {
  groups: Methods;
  accounts: Methods;
  recordings: Methods;
  users: Methods;
  profile: Methods;
  notifications: Methods;
  dubPoints: Methods;
  testConnection: Mock;
  revokeToken: Mock;
}

export interface StubOverrides {
  groups?: Methods;
  accounts?: Methods;
  recordings?: Methods;
  users?: Methods;
  profile?: Methods;
  notifications?: Methods;
  dubPoints?: Methods;
  testConnection?: Mock;
  revokeToken?: Mock;
}

export type StubClient = StubTree & DubberClient;

export function stubClient(overrides: StubOverrides = {}): StubClient {
  const tree: StubTree = {
    groups: {
      get: vi.fn(async () => ({ id: "grp-1", name: "Group" })),
      createChild: vi.fn(async () => ({ id: "grp-2", name: "Child" })),
      listUnidentifiedRecordings: vi.fn(async () => []),
      createUnidentifiedRecording: vi.fn(async () => ({ id: "rec-1" })),
      ...overrides.groups,
    },
    accounts: {
      create: vi.fn(async () => ({ id: "acc-1", name: "Account" })),
      get: vi.fn(async () => ({ id: "acc-1", name: "Account" })),
      update: vi.fn(async () => ({ id: "acc-1", name: "Account" })),
      ...overrides.accounts,
    },
    recordings: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "rec-1" })),
      get: vi.fn(async () => ({ id: "rec-1" })),
      getWaveform: vi.fn(async () => ({ recording_id: "rec-1" })),
      download: vi.fn(async () => ({ data: new Uint8Array(), contentType: "audio/wav" })),
      delete: vi.fn(async () => undefined),
      updateMetadata: vi.fn(async () => ({ id: "rec-1" })),
      addTags: vi.fn(async () => ({ id: "rec-1" })),
      deleteTags: vi.fn(async () => ({ id: "rec-1" })),
      initiateMultipart: vi.fn(async () => ({ id: "rec-1" })),
      getUploadTarget: vi.fn(async () => ({ recording_id: "rec-1", upload_url: "https://upload.example.com" })),
      completeUpload: vi.fn(async () => ({ id: "rec-1" })),
      ...overrides.recordings,
    },
    users: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "usr-1" })),
      get: vi.fn(async () => ({ id: "usr-1" })),
      update: vi.fn(async () => ({ id: "usr-1" })),
      delete: vi.fn(async () => undefined),
      ...overrides.users,
    },
    profile: {
      get: vi.fn(async () => ({ id: "usr-1", email: "agent@example.com" })),
      ...overrides.profile,
    },
    notifications: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "notif-1" })),
      get: vi.fn(async () => ({ id: "notif-1" })),
      update: vi.fn(async () => ({ id: "notif-1" })),
      activate: vi.fn(async () => ({ id: "notif-1", active: true })),
      listUnclaimed: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      ...overrides.notifications,
    },
    dubPoints: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "dp-1" })),
      get: vi.fn(async () => ({ id: "dp-1" })),
      find: vi.fn(async () => []),
      ...overrides.dubPoints,
    },
    testConnection: overrides.testConnection ?? vi.fn(async () => ({ ok: true })),
    revokeToken: overrides.revokeToken ?? vi.fn(async () => undefined),
  };
  return tree as unknown as StubClient;
}
