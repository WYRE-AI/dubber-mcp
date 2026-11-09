/**
 * Output and log hygiene. Tool output is redacted by credential-named keys,
 * by exact match on the credentials in use, and by token shape. Logs get one
 * extra pass: signed-URL signatures (e.g. a recording_url) are stripped,
 * because those links are bearer access to call audio.
 *
 * recording_url itself is NOT redacted from tool output: returning it to the
 * caller is the purpose of dubber_recordings_get with `listener`.
 */

export const REDACTED = "[REDACTED]";

/** Normalized (lower-case, no `_`/`-`) key names whose string values are credentials. */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "xdubberclientsecret",
  "xdubberauthtoken",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

/** Recursively replaces string values under credential-named keys. Returns a new value. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && typeof v === "string" && v.length > 0 ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

const TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Pattern-based redaction plus exact removal of any secrets known for this request. */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of TEXT_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Query parameters that make a pre-signed URL usable by whoever holds it. */
const SIGNED_URL_PARAM = /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|AWSAccessKeyId|Key-Pair-Id|Policy)=)[^&\s"'\\]+/gi;

/** For log lines only: redactText plus signed-URL signatures. */
export function redactLogText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  return redactText(text, knownSecrets).replace(SIGNED_URL_PARAM, `$1${REDACTED}`);
}
