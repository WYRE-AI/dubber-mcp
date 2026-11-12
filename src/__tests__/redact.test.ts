import { describe, expect, it } from "vitest";
import { REDACTED, redactText, redactValue } from "../redact.js";

describe("redactText: JWT pattern", () => {
  it("still redacts a real-looking JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactText(`token ${jwt} end`)).toBe(`token ${REDACTED} end`);
  });

  it.each([
    ["repeated eyJ-", "eyJ-".repeat(250_000)],
    ["repeated eyJa", "eyJa".repeat(250_000)],
    ["repeated eyJaaaaaaaa.", "eyJaaaaaaaa.".repeat(85_000)],
  ])("finishes well under a second on hostile input: %s", (_label, input) => {
    const started = performance.now();
    redactText(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("redactValue: credential-named keys", () => {
  it("redacts strings, numbers, booleans, objects and arrays under a credential key", () => {
    const out = redactValue({
      access_token: "abc",
      clientSecret: 12345,
      api_key: true,
      password: { nested: "value" },
      signing_key: ["a", "b"],
    });
    expect(out).toEqual({
      access_token: REDACTED,
      clientSecret: REDACTED,
      api_key: REDACTED,
      password: REDACTED,
      signing_key: REDACTED,
    });
  });

  it("keeps null and leaves non-credential keys alone", () => {
    const out = redactValue({ token: null, token_type: "Bearer", recording_id: 7, flag: false });
    expect(out).toEqual({ token: null, token_type: "Bearer", recording_id: 7, flag: false });
  });

  it("redacts under credential keys nested in arrays", () => {
    expect(redactValue({ hooks: [{ webhook_secret: 42, url: "https://x.example" }] })).toEqual({
      hooks: [{ webhook_secret: REDACTED, url: "https://x.example" }],
    });
  });
});
