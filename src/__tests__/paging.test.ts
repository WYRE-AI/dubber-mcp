import { describe, expect, it } from "vitest";
import { rereadGuidance } from "../handlers/paging.js";

describe("rereadGuidance keeps the trimmed page's start offset", () => {
  it("first page (page omitted) is page 0 or page 1", () => {
    const note = rereadGuidance(40, 100, undefined);
    expect(note).toContain("count=25");
    expect(note).toContain("page=0 through page=3 if Dubber pages start at 0");
    expect(note).toContain("page=1 through page=4 if they start at 1");
  });

  it("page=2, count=100, 60 kept -> count=50 pages 4-5 (0-based) or 3-4 (1-based)", () => {
    const note = rereadGuidance(60, 100, 2);
    expect(note).toContain("count=50");
    expect(note).toContain("page=4 through page=5 if Dubber pages start at 0");
    expect(note).toContain("page=3 through page=4 if they start at 1");
  });

  it("page=0 has no 1-based reading", () => {
    const note = rereadGuidance(10, 20, 0);
    expect(note).toContain("count=10");
    expect(note).toContain("page=0 through page=1 if Dubber pages start at 0");
    expect(note).not.toContain("start at 1");
  });

  it("a prime count falls back to count=1", () => {
    const note = rereadGuidance(5, 7, 1);
    expect(note).toContain("count=1");
    expect(note).toContain("page=7 through page=13 if Dubber pages start at 0");
    expect(note).toContain("page=1 through page=7 if they start at 1");
  });

  it("never tells the caller to advance first", () => {
    expect(rereadGuidance(50, 100, 3)).toContain("Do not move on to the next page yet");
  });
});

describe("listResult measures the redacted text", () => {
  it("trims items when pattern redaction would push the result over the cap", async () => {
    const { listResult } = await import("../handlers/results.js");
    const { redactText } = await import("../redact.js");
    const { MAX_RESPONSE_CHARS } = await import("../config.js");
    // Each "Bearer a " (9 chars) becomes "[REDACTED] " (11 chars) after redaction.
    // Under the cap before redaction, over it after.
    const per = Math.floor((MAX_RESPONSE_CHARS - 500) / 9 / 2);
    const items = [0, 1].map((i) => ({ id: `n-${i}`, notes: "Bearer a ".repeat(per) }));
    const result = listResult({}, "items", items, () => ({ note: "trimmed" }));
    const out = (result.content[0] as { text: string }).text;
    // What mcp-server.ts sends: redactText again (a no-op now), then truncate only if still too long.
    const sent = redactText(out);
    expect(sent).toBe(out);
    const body = JSON.parse(sent) as { items: unknown[]; note?: string };
    expect(body.items).toHaveLength(1);
    expect(body.note).toBe("trimmed");
  });
});
