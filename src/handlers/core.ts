/** dubber_test_connection: mint an OAuth token and report the result. */
import type { DubberClient } from "@wyre-ai/node-dubber";
import { errorResult, jsonResult, type ToolHandler, type ToolResult } from "./results.js";

const ENTITLEMENT_NOTE =
  "A minted token proves the client ID/secret and Dubber Auth ID/Token only. It does not " +
  "prove access to any specific account, recording, or Dub.Point.";

async function testConnection(client: DubberClient): Promise<ToolResult> {
  const result = await client.testConnection();
  const report = { ...result, note: ENTITLEMENT_NOTE };
  if (!result.ok) {
    return errorResult(`Dubber credentials were rejected: the token could not be minted.\n${JSON.stringify(report, null, 2)}`);
  }
  return jsonResult(report);
}

export const CORE_HANDLERS: Record<string, ToolHandler> = {
  dubber_test_connection: testConnection,
};
