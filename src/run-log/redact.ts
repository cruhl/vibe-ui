/** The shapes of the providers' API keys: OpenAI, OpenRouter, Anthropic, Reactor, TypeSafe, fal. */
export const keyShapes: readonly RegExp[] = [
  /sk-(?:proj-|or-v1-|ant-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:rk|apikey|fal_sk)_[A-Za-z0-9_-]{20,}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/,
];

const secretShapes: readonly RegExp[] = [
  ...keyShapes,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:Bearer|Key)\s+[A-Za-z0-9._:~+/=-]{12,}/,
];

/**
 * Text with every given secret (at least 8 characters) and anything shaped like an API key, a
 * signed token or an Authorization value replaced by `[redacted]`.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  const literal = secrets
    .filter((secret) => secret.length >= 8)
    .reduce((current, secret) => current.replaceAll(secret, "[redacted]"), text);
  return secretShapes.reduce(
    (current, shape) => current.replace(new RegExp(shape.source, "g"), "[redacted]"),
    literal,
  );
}
