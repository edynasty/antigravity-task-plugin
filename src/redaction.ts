/**
 * Deterministic redaction of credential-like values, shared by the protocol
 * parser (diagnostic context, Todo 3) and the runner (stderr/diagnostic
 * output, Todo 5) so both boundaries use one pattern set and cannot drift.
 * Pure string transform: no environment, filesystem, or network access.
 */

export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\-/=]+/g,
  /\b(?:api[_-]?key|apikey|token|secret)\s*[=:]\s*[A-Za-z0-9._~+\-/=]+/gi,
];

export function redactCredentials(line: string): string {
  let redacted = line;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}
