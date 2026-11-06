const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]"],
  [/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, "[REDACTED TOKEN]"],
  [/\b(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, "$1[REDACTED]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[REDACTED]"],
  [/\b([A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|token)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, "$1[REDACTED]"],
]

export function redact(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}
