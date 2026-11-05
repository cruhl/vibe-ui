const fencedJSON = /```json\n([\s\S]*?)\n```/;

/**
 * The first fenced json block of a markdown text, parsed, with the text around it; null when it
 * has none. Throws when the block is not valid JSON.
 */
export function jsonBlock(markdown: string): { json: unknown; rest: string } | null {
  const match = fencedJSON.exec(markdown);
  const block = match?.[1];
  if (match === null || block === undefined) return null;
  const json: unknown = JSON.parse(block);
  return { json, rest: markdown.replace(match[0], "").trim() };
}
