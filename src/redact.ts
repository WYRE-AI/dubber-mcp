/**
 * Output and log hygiene. Tool output is redacted by credential-named keys,
 * by exact match on the credentials in use, and by token shape. Logs get one
 * extra pass: signed-URL signatures (e.g. a recording_url) are stripped,
 * because those links are bearer access to call audio.
 *
 * recording_url (and waveform_url) is NOT redacted from tool output:
 * returning it to the caller is the purpose of dubber_recordings_get_link
 * (and dubber_recordings_get_waveform).
 */

export const REDACTED = "[REDACTED]";

/** Normalized (lower-case, no `_`/`-`) key names whose values are credentials. */
const SENSITIVE_KEYS = new Set(["authorization", "hmac"]);

/**
 * Any normalized key ENDING in one of these is a credential too: token, apikey, signingkey,
 * hmackey, webhooksecret, clientsecret, xdubberauthtoken, password, ... Ids (`*_id`), links
 * (`recording_url`) and `token_type` do not end this way, so they are still returned.
 */
const SENSITIVE_SUFFIX = /(secret|token|key|password)$/;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_SUFFIX.test(normalized);
}

/** Recursively replaces any non-null value (string, number, boolean, object, array) under a credential-named key. Returns a new value. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && v !== null && v !== undefined ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

const TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Bounded quantifiers, and no hyphen in the first segment, so a hostile body
  // (up to 4 MiB of upstream text is redacted) cannot make the match quadratic.
  /\beyJ[A-Za-z0-9_]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\b/g,
];

/**
 * Pattern-based redaction plus exact removal of any secrets known for this
 * request, both raw and in their JSON-escaped form (tool output and log lines
 * are JSON-stringified, so a `"` or `\` in a secret appears escaped).
 */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 4) continue;
    for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) out = out.split(form).join(REDACTED);
  }
  for (const pattern of TEXT_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Cuts text to maxChars. Call it only on text that is already redacted, so a secret straddling
 * the cut can never survive as a partial prefix. List results are trimmed by item before this
 * (handlers/results.ts listResult), so this only fires for one oversized item.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return (
    `${text.slice(0, maxChars)}\n\n[truncated: ${omitted} more characters omitted. ` +
    "Narrow the request (a smaller limit or count, a shorter time range, or a single id).]"
  );
}

/** Query parameters that make a pre-signed URL usable by whoever holds it. */
const SIGNED_URL_PARAM = /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|AWSAccessKeyId|Key-Pair-Id|Policy)=)[^&\s"'\\]+/gi;

/** For log lines only: redactText plus signed-URL signatures. */
export function redactLogText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  return redactText(text, knownSecrets).replace(SIGNED_URL_PARAM, `$1${REDACTED}`);
}
