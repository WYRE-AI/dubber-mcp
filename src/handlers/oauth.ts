import type { DubberClient } from "@wyre-ai/node-dubber";
import { confirmDestructive, type ElicitationContext } from "../elicitation.js";
import { errorResult, textResult, type ToolHandler } from "./results.js";

const CANCELLED = "Cancelled — nothing was changed.";

async function revokeToken(client: DubberClient, args: Record<string, unknown>, elicitation: ElicitationContext) {
  const gate = confirmDestructive(
    elicitation,
    args,
    "Revoke the current Dubber OAuth token? Other in-flight calls on this session will start failing."
  );
  if (gate.kind === "ask") return gate.result;
  if (gate.kind === "blocked") return errorResult(gate.message);
  if (gate.kind === "refused") return textResult(CANCELLED);

  await client.revokeToken();
  return textResult("Token revoked. A fresh token will be minted automatically on the next call.");
}

export const OAUTH_HANDLERS: Record<string, ToolHandler> = {
  dubber_oauth_revoke_token: revokeToken,
};
