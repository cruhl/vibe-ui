/**
 * Fills the `{name}` slots of a template that `values` names; any other braces, such as slots a
 * model is asked to write itself, stay as written.
 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/**
 * Reads a phrasing file: every line of the form `key: text` becomes one entry, and every other
 * line (headings, notes for the reader) is left out.
 */
export function phrases(markdown: string): Map<string, string> {
  return new Map(
    markdown
      .split("\n")
      .map((line) => /^([a-z0-9-]+): (.*)$/.exec(line.trim()))
      .flatMap((match) => (match === null ? [] : [[match[1] ?? "", match[2] ?? ""] as const])),
  );
}

/** One phrase of a phrasing file with its slots filled; throws when the file has no such key. */
export function phrase(
  phrasing: ReadonlyMap<string, string>,
  file: string,
  key: string,
  values: Readonly<Record<string, string>> = {},
): string {
  const template = phrasing.get(key);
  if (template === undefined) throw new Error(`${file} has no ${key}`);
  return fill(template, values);
}
