/** dubber_test_connection: one authenticated GET /profile, and the result. */
import type { DubberApi } from "../dubber-api.js";
import { errorResult, jsonResult, type ToolHandler, type ToolResult } from "./results.js";

const ENTITLEMENT_NOTE =
  "A successful check proves the client ID/secret and Dubber Auth ID/Token work right now. It does " +
  "not prove access to any specific account, recording, or Dub.Point.";

async function testConnection(client: DubberApi): Promise<ToolResult> {
  const result = await client.testConnection();
  const report = { ...result, note: ENTITLEMENT_NOTE };
  if (!result.ok) {
    return errorResult(`Dubber connection check failed.\n${JSON.stringify(report, null, 2)}`);
  }
  return jsonResult(report);
}

export const CORE_HANDLERS: Record<string, ToolHandler> = {
  dubber_test_connection: testConnection,
};
