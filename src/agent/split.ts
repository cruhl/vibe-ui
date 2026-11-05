/**
 * Splits a line where the model glued the next op onto a finished sentence, as in
 * `> Stone scrapes softly.? make-fire 0.8`: a sentence end followed directly by an op sigil and
 * an id or a guess header starts a new line.
 */
export function splitGlued(line: string): string[] {
  return line.split(/(?<=[.!])\s*(?=\? [a-z]|[~=+*%>-][a-z])/);
}

/**
 * The lines one streamed answer hands over, in order, exactly as the stream reader emits them:
 * split at newlines and glued sentence ends, trimmed, with blank lines and code fences dropped.
 */
export function answerLines(text: string): string[] {
  return text
    .split("\n")
    .flatMap(splitGlued)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("```"));
}
