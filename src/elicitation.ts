/**
 * Elicitation helpers for MCP tool handlers — SDK v2 MRTR seam.
 *
 * Under the 2026-07-28 protocol there is no server→client request channel:
 * a handler that needs input RETURNS an `input_required` result (built with
 * the SDK's `inputRequired()` builder). The client fulfils the embedded
 * `elicitation/create` request and retries the ORIGINAL request with
 * `inputResponses`; on 2025-era stateful connections (e.g. stdio) the SDK's
 * default-on legacy shim fulfils the same return server-side. Either way the
 * handler re-executes from the top on retry, so handlers must complete all
 * reads and elicitation BEFORE the single mutating vendor call.
 *
 * Graceful degradation (design.md §4) is preserved for OPTIONAL elicitation:
 * when the caller never declared form-elicitation capability — including the
 * stateless legacy path, where per-request instances see no `initialize` —
 * helpers report `unavailable` and callers fall back to their pre-elicitation
 * behavior (a default date range, an error listing the candidates, …).
 *
 * Destructive actions do NOT degrade that way. `unavailable` is the absence of
 * consent, not consent, and the production caller (the WYRE Conduit gateway)
 * is exactly such a client — so a permissive fallback there means every delete
 * runs unconfirmed. `confirmDestructive` below fails closed instead: it blocks
 * with an actionable error unless the caller passed `CONFIRM_ARG` explicitly.
 */
import { inputRequired, inputResponse } from "@modelcontextprotocol/server";
import type { ClientCapabilities, InputRequiredResult } from "@modelcontextprotocol/server";

/** Per-request elicitation context, threaded in by the tools/call handler. */
export interface ElicitationContext {
  /**
   * The caller's declared capabilities: per-request envelope on 2026-07-28
   * requests, `initialize`-scoped on 2025-era connections, undefined on the
   * stateless legacy path (no elicitation is possible there).
   */
  clientCapabilities?: ClientCapabilities;
  /** MRTR input responses carried by a retried request (untrusted input). */
  inputResponses?: Record<string, unknown>;
}

/** The context used when no elicitation is possible (tests, direct calls). */
export const NO_ELICITATION: ElicitationContext = {};

/** The outcome of one elicitation point. */
export type ElicitOutcome<T> =
  /** The user answered — proceed with the value. */
  | { kind: "answer"; value: T }
  /** The user explicitly declined or cancelled. */
  | { kind: "declined" }
  /** Return `result` from the tool handler; the caller retries with the answer. */
  | { kind: "ask"; result: InputRequiredResult }
  /** The caller cannot answer elicitation — use the pre-elicitation fallback. */
  | { kind: "unavailable" };

export interface ElicitOption {
  value: string;
  label: string;
}

/**
 * Whether the caller declared form-mode elicitation. A bare
 * `elicitation: {}` declaration counts as form (the pre-mode 2025 meaning),
 * mirroring the SDK's own capability gate.
 */
function supportsFormElicitation(ctx: ElicitationContext): boolean {
  const elicitation = ctx.clientCapabilities?.elicitation;
  if (elicitation === undefined) return false;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}

/**
 * Shared MRTR seam: read the retried request's response for `key`, or build
 * the `input_required` result asking for it. `read` extracts the typed
 * answer from accepted content; `undefined` reads as a decline (the values
 * arrive from the client and are untrusted).
 */
function elicit<T>(
  ctx: ElicitationContext,
  key: string,
  properties: Record<string, unknown>,
  message: string,
  read: (content: Record<string, unknown>) => T | undefined
): ElicitOutcome<T> {
  const response = inputResponse(ctx.inputResponses, key);
  if (response.kind === "elicit") {
    if (response.action === "accept" && response.content) {
      const value = read(response.content);
      if (value !== undefined) return { kind: "answer", value };
    }
    return { kind: "declined" };
  }
  if (!supportsFormElicitation(ctx)) return { kind: "unavailable" };
  return {
    kind: "ask",
    result: inputRequired({
      inputRequests: {
        [key]: inputRequired.elicit({
          message,
          requestedSchema: {
            type: "object",
            properties,
            required: [key],
          } as Parameters<typeof inputRequired.elicit>[0]["requestedSchema"],
        }),
      },
    }),
  };
}

/** Ask the user to select from a list of options (keyed by `fieldName`). */
export function elicitSelection(
  ctx: ElicitationContext,
  message: string,
  fieldName: string,
  options: ElicitOption[]
): ElicitOutcome<string> {
  return elicit(
    ctx,
    fieldName,
    {
      [fieldName]: {
        type: "string",
        title: fieldName,
        description: `Select a ${fieldName}`,
        enum: options.map((o) => o.value),
        enumNames: options.map((o) => o.label),
      },
    },
    message,
    (content) => {
      const value = content[fieldName];
      // Untrusted input: only a value from the offered options counts.
      return options.some((o) => o.value === value) ? (value as string) : undefined;
    }
  );
}

/** Ask the user for a free-text input (keyed by `fieldName`). */
export function elicitText(
  ctx: ElicitationContext,
  message: string,
  fieldName: string,
  description?: string
): ElicitOutcome<string> {
  return elicit(
    ctx,
    fieldName,
    {
      [fieldName]: {
        type: "string",
        title: fieldName,
        description: description ?? `Enter ${fieldName}`,
      },
    },
    message,
    (content) => (typeof content[fieldName] === "string" ? (content[fieldName] as string) : undefined)
  );
}

/**
 * Ask the user to confirm an action (keyed `confirm`). An accepted
 * `confirm: false` reads as an answer of `false`, which — like `declined` —
 * means cancel. Destructive callers must not consume this outcome directly:
 * route them through `confirmDestructive`, which owns what `unavailable`
 * means for an irreversible action.
 */
export function elicitConfirmation(
  ctx: ElicitationContext,
  message: string
): ElicitOutcome<boolean> {
  return elicit(
    ctx,
    "confirm",
    {
      confirm: {
        type: "boolean",
        title: "Confirm",
        description: "Confirm this action",
      },
    },
    message,
    (content) => (typeof content.confirm === "boolean" ? content.confirm : undefined)
  );
}

/** True when the outcome means the user said no (declined or answered false). */
export function isRefusal(outcome: ElicitOutcome<boolean>): boolean {
  return outcome.kind === "declined" || (outcome.kind === "answer" && !outcome.value);
}

/**
 * The argument through which a caller that cannot be prompted supplies
 * confirmation for a destructive action. Declared to callers by
 * `CONFIRM_ARG_PROPERTY` — the gate below is only satisfiable because the
 * argument is visible in the destructive tools' input schemas.
 */
export const CONFIRM_ARG = "confirm_destructive_action";

/** Input-schema fragment for `CONFIRM_ARG`; spread into destructive tools' `properties`. */
export const CONFIRM_ARG_PROPERTY = {
  [CONFIRM_ARG]: {
    type: "boolean" as const,
    description:
      "Explicit confirmation for this action. Required only when the client " +
      "declared no elicitation capability and therefore cannot be prompted (e.g. the " +
      "gateway); interactive clients are prompted instead, and this argument never " +
      "suppresses that prompt.",
  },
};

/** What a destructive handler should do next. */
export type DestructiveGate =
  /** Confirmed — run the mutation. */
  | { kind: "proceed" }
  /** Return `result`; the caller retries with the user's answer. */
  | { kind: "ask"; result: InputRequiredResult }
  /** The user said no — cancel, in the handler's own words. */
  | { kind: "refused" }
  /** Nobody can confirm — return `message` as an error and mutate nothing. */
  | { kind: "blocked"; message: string };

/**
 * The consent gate for irreversible actions. Interactive callers are prompted
 * exactly as before. Callers that cannot be prompted must pass
 * `CONFIRM_ARG: true`; without it the action is BLOCKED, because a client that
 * cannot answer has not consented (see the module header).
 *
 * The prompt always wins where it is available: passing the argument never
 * skips a confirmation an interactive user would otherwise have seen.
 */
export function confirmDestructive(
  ctx: ElicitationContext,
  args: Record<string, unknown>,
  message: string
): DestructiveGate {
  const outcome = elicitConfirmation(ctx, message);
  if (outcome.kind === "ask") return { kind: "ask", result: outcome.result };
  if (outcome.kind === "unavailable") {
    if (args[CONFIRM_ARG] === true) return { kind: "proceed" };
    return {
      kind: "blocked",
      message:
        "Confirmation required, but this client cannot be prompted for it (it declared " +
        `no elicitation capability). Nothing was changed. Pending action: ${message} ` +
        `To proceed, re-invoke this tool with "${CONFIRM_ARG}": true.`,
    };
  }
  return isRefusal(outcome) ? { kind: "refused" } : { kind: "proceed" };
}
