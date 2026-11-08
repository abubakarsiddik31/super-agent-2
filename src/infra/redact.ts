/**
 * Removes credential-shaped text from anything that may reach a model, the panel or a stored report.
 *
 * Command output is the usual carrier: a prepare command, a test run or a CLI failure prints what it printed, and that text
 * then becomes a ticket's failure summary, a worker's report and a relay to the main Session. The patterns are deliberately
 * narrow, so ordinary prose survives, and the length cap keeps one runaway output from filling the router's context.
 */
/** A credential-shaped pattern and what replaces it. Each keeps the surrounding text, so the cause stays readable. */
const SECRETS: readonly { pattern: RegExp; replace: string }[] = [
  // GitHub tokens, including the fine-grained and app forms.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: '[redacted github token]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: '[redacted github token]' },
  // Provider API keys and Slack tokens.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: '[redacted key]' },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: '[redacted slack token]' },
  // AWS access key ids, and a JSON Web Token, which is three base64url segments.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[redacted access key]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: '[redacted token]' },
  // A private key block, whose body is the secret; the markers stay so the reader sees what it was.
  { pattern: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, replace: '$1[redacted]$2' },
  // An authorization header, and the common `name=value` and `name: value` forms of a secret.
  { pattern: /(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, replace: '$1[redacted]' },
  { pattern: /(\b(?:token|secret|password|passwd|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    replace: '$1[redacted]' },
]
/** The longest text `redactSecrets` returns by default. */
export const REDACTED_MAX_CHARS = 2000
/**
 * Replaces credential-shaped substrings in `text` and caps the result at `maxChars`, with an ellipsis when it was longer.
 * Redaction runs first, so a token cut in half by the cap cannot survive.
 */
export function redactSecrets(text: string, maxChars = REDACTED_MAX_CHARS): string {
  let redacted = text
  for (const { pattern, replace } of SECRETS) redacted = redacted.replace(pattern, replace)
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted
}
