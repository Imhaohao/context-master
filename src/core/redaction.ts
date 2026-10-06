const credentialPatterns = [
  /\b(?:sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*["']?([A-Za-z0-9_./+\-=]{12,})["']?/gi,
  /\bBearer\s+[A-Za-z0-9_./+\-=]{16,}/gi
];
export function redactCredentials(text: string): { text: string; count: number } {
  let count = 0;
  let result = text;
  for (const pattern of credentialPatterns) result = result.replace(pattern, () => { count++; return '[credential redacted]'; });
  return { text: result, count };
}
