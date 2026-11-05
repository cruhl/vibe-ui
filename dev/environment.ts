import { existsSync, readFileSync } from "node:fs";

/** Reads `.env.local` into a key/value record, or an empty record when the file is absent. */
export function readLocalEnvironment(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      const value = line
        .slice(index + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      return [line.slice(0, index).trim(), value] as const;
    });
  return Object.fromEntries(entries);
}
