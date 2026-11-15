/**
 * A network-free DubberApi for handler tests. Every SDK method used by
 * the handlers is a vi.fn() with a harmless default, so a test overrides
 * only the calls it cares about:
 *
 *   const client = stubClient({
 *     recordings: { get: vi.fn(async () => RECORDING) },
 *   });
 *   await handleToolCall(client, "dubber_recordings_get", { recordingId: "rec-1" });
 *   expect(client.recordings.get).toHaveBeenCalledWith("rec-1");
 *
 * The result is typed as both the mock tree and a DubberApi, so it can be
 * passed to handlers directly and still expose `.mock` for assertions.
 * Build it inside each test: vitest.config.ts sets `mockReset: true`.
 * What actually goes on the wire is asserted in security-contract.test.ts.
 */
import { vi, type Mock } from "vitest";
import type { DubberApi } from "../dubber-api.js";

type Methods = Record<string, Mock>;

export interface StubTree {
  groups: Methods;
  accounts: Methods;
  recordings: Methods;
  users: Methods;
  profile: Methods;
  notifications: Methods;
  dubPoints: Methods;
  request: Mock;
  testConnection: Mock;
}

export interface StubOverrides {
  groups?: Methods;
  accounts?: Methods;
  recordings?: Methods;
  users?: Methods;
  profile?: Methods;
  notifications?: Methods;
  dubPoints?: Methods;
  request?: Mock;
  testConnection?: Mock;
}

export type StubClient = StubTree & DubberApi;

export function stubClient(overrides: StubOverrides = {}): StubClient {
  const tree: StubTree = {
    groups: {
      get: vi.fn(async () => ({ id: "grp-1", name: "Group" })),
      ...overrides.groups,
    },
    accounts: {
      get: vi.fn(async () => ({ id: "acc-1", name: "Account" })),
      ...overrides.accounts,
    },
    recordings: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: "rec-1" })),
      getWaveform: vi.fn(async () => ({ recording_id: "rec-1" })),
      ...overrides.recordings,
    },
    users: {
      get: vi.fn(async () => ({ id: "usr-1" })),
      ...overrides.users,
    },
    profile: {
      get: vi.fn(async () => ({ id: "usr-1", email: "agent@example.com" })),
      ...overrides.profile,
    },
    notifications: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: "notif-1" })),
      ...overrides.notifications,
    },
    dubPoints: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({ id: "dp-1" })),
      find: vi.fn(async () => []),
      ...overrides.dubPoints,
    },
    request: overrides.request ?? vi.fn(async () => []),
    testConnection: overrides.testConnection ?? vi.fn(async () => ({ ok: true })),
  };
  return tree as unknown as StubClient;
}
