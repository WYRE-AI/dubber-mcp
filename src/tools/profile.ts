/** Tool: the authenticated application/user's own profile. */
import type { Tool } from "@modelcontextprotocol/server";

export const PROFILE_TOOLS: Tool[] = [
  {
    name: "dubber_profile_get",
    description: "Get the profile of the authenticated Dubber user/application.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
