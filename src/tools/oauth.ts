/** Tool: OAuth token revocation. */
import type { Tool } from "@modelcontextprotocol/server";
import { CONFIRM_ARG_PROPERTY } from "../elicitation.js";

export const OAUTH_TOOLS: Tool[] = [
  {
    name: "dubber_oauth_revoke_token",
    description:
      "⚠ HIGH-IMPACT. Revokes the current Dubber OAuth access token. Any other in-flight " +
      "calls using this session's token will start failing immediately; a fresh token is " +
      "minted automatically on the next call, so this is reversible in effect but disruptive " +
      "in the moment. Confirm with the user before invoking.",
    inputSchema: { type: "object", properties: { ...CONFIRM_ARG_PROPERTY } },
    annotations: {
      title: "Revoke current OAuth token",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
