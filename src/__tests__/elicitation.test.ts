/**
 * Elicitation helpers (MRTR seam): capability-gated `input_required` asks,
 * response consumption on retry, and the unavailable fallback.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIRM_ARG,
  confirmDestructive,
  elicitConfirmation,
  elicitSelection,
  elicitText,
  isRefusal,
  type ElicitationContext,
} from "../elicitation.js";

const FORM_CAPABLE: ElicitationContext = { clientCapabilities: { elicitation: {} } };

function answered(key: string, content: Record<string, unknown>): ElicitationContext {
  return {
    clientCapabilities: { elicitation: {} },
    inputResponses: { [key]: { action: "accept", content } },
  };
}

describe("capability gate (design.md §4 graceful fallback)", () => {
  it("no declared capabilities → unavailable for all helpers", () => {
    const ctx: ElicitationContext = {};
    expect(elicitText(ctx, "m", "f").kind).toBe("unavailable");
    expect(elicitSelection(ctx, "m", "f", [{ value: "a", label: "A" }]).kind).toBe("unavailable");
    expect(elicitConfirmation(ctx, "m").kind).toBe("unavailable");
  });

  it("url-only elicitation capability → unavailable (form is not implied)", () => {
    const ctx: ElicitationContext = { clientCapabilities: { elicitation: { url: {} } } };
    expect(elicitConfirmation(ctx, "m").kind).toBe("unavailable");
  });

  it("bare elicitation {} counts as form (the pre-mode meaning)", () => {
    expect(elicitConfirmation(FORM_CAPABLE, "m").kind).toBe("ask");
  });

  it("explicit form capability → ask", () => {
    const ctx: ElicitationContext = { clientCapabilities: { elicitation: { form: {} } } };
    expect(elicitText(ctx, "m", "f").kind).toBe("ask");
  });
});

describe("the ask leg builds an input_required result", () => {
  it("confirmation embeds an elicitation/create request keyed 'confirm'", () => {
    const outcome = elicitConfirmation(FORM_CAPABLE, "Really delete?");
    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    expect(outcome.result.resultType).toBe("input_required");
    const request = outcome.result.inputRequests?.confirm;
    expect(request?.method).toBe("elicitation/create");
    const params = request?.params as {
      message: string;
      requestedSchema: { required?: string[] };
    };
    expect(params.message).toBe("Really delete?");
    expect(params.requestedSchema.required).toEqual(["confirm"]);
  });

  it("selection embeds the offered options as an enum", () => {
    const outcome = elicitSelection(FORM_CAPABLE, "Pick one", "template", [
      { value: "t-1", label: "One" },
      { value: "t-2", label: "Two" },
    ]);
    expect(outcome.kind).toBe("ask");
    if (outcome.kind !== "ask") return;
    const params = outcome.result.inputRequests?.template?.params as {
      requestedSchema: { properties: Record<string, { enum?: string[] }> };
    };
    expect(params.requestedSchema.properties.template.enum).toEqual(["t-1", "t-2"]);
  });
});

describe("consuming a retried request's responses", () => {
  it("text answers pass through", () => {
    const outcome = elicitText(answered("f", { f: "hello" }), "m", "f");
    expect(outcome).toEqual({ kind: "answer", value: "hello" });
  });

  it("selection returns the chosen value", () => {
    const outcome = elicitSelection(answered("f", { f: "b" }), "m", "f", [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ]);
    expect(outcome).toEqual({ kind: "answer", value: "b" });
  });

  it("a selection outside the offered options reads as declined (untrusted input)", () => {
    const outcome = elicitSelection(answered("f", { f: "evil" }), "m", "f", [
      { value: "a", label: "A" },
    ]);
    expect(outcome.kind).toBe("declined");
  });

  it("confirmation distinguishes accept-true, accept-false, and decline", () => {
    expect(elicitConfirmation(answered("confirm", { confirm: true }), "m")).toEqual({
      kind: "answer",
      value: true,
    });

    const acceptFalse = elicitConfirmation(answered("confirm", { confirm: false }), "m");
    expect(acceptFalse).toEqual({ kind: "answer", value: false });
    expect(isRefusal(acceptFalse)).toBe(true);

    const declined = elicitConfirmation(
      {
        clientCapabilities: { elicitation: {} },
        inputResponses: { confirm: { action: "decline" } },
      },
      "m"
    );
    expect(declined.kind).toBe("declined");
    expect(isRefusal(declined)).toBe(true);

    expect(isRefusal({ kind: "answer", value: true })).toBe(false);
    expect(isRefusal({ kind: "unavailable" })).toBe(false);
  });

  it("responses are consumed even without a capability view (shim-fulfilled retries)", () => {
    const outcome = elicitConfirmation(
      { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
      "m"
    );
    expect(outcome).toEqual({ kind: "answer", value: true });
  });
});

describe("confirmDestructive (fail-closed gate for irreversible actions)", () => {
  const NON_INTERACTIVE: ElicitationContext = {};

  it("non-interactive caller without explicit confirmation → blocked", () => {
    const gate = confirmDestructive(NON_INTERACTIVE, {}, "Permanently delete quote X?");
    expect(gate.kind).toBe("blocked");
    if (gate.kind !== "blocked") return;
    expect(gate.message).toContain(CONFIRM_ARG);
    expect(gate.message).toContain("Permanently delete quote X?");
  });

  it("non-interactive caller with an explicit confirmation → proceeds", () => {
    expect(confirmDestructive(NON_INTERACTIVE, { [CONFIRM_ARG]: true }, "m").kind).toBe(
      "proceed"
    );
  });

  it("only a literal true satisfies the gate", () => {
    for (const value of ["true", 1, {}, false, null, undefined]) {
      expect(confirmDestructive(NON_INTERACTIVE, { [CONFIRM_ARG]: value }, "m").kind).toBe(
        "blocked"
      );
    }
  });

  it("url-only elicitation is still non-interactive for confirmations", () => {
    const ctx: ElicitationContext = { clientCapabilities: { elicitation: { url: {} } } };
    expect(confirmDestructive(ctx, {}, "m").kind).toBe("blocked");
  });

  it("a promptable caller is always prompted — the argument cannot skip it", () => {
    expect(confirmDestructive(FORM_CAPABLE, {}, "m").kind).toBe("ask");
    expect(confirmDestructive(FORM_CAPABLE, { [CONFIRM_ARG]: true }, "m").kind).toBe("ask");
  });

  it("an answered prompt decides: accept → proceed, reject/decline → refused", () => {
    expect(confirmDestructive(answered("confirm", { confirm: true }), {}, "m").kind).toBe(
      "proceed"
    );
    expect(confirmDestructive(answered("confirm", { confirm: false }), {}, "m").kind).toBe(
      "refused"
    );
    expect(
      confirmDestructive(
        {
          clientCapabilities: { elicitation: {} },
          inputResponses: { confirm: { action: "decline" } },
        },
        {},
        "m"
      ).kind
    ).toBe("refused");
  });
});
