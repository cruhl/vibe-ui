import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { folderScenarios } from "./folders.ts";

const root = join(import.meta.dirname, "..", "..");
const folders = join(root, "src", "presets");
const scanned = ["src", "scripts", "dev", "vite.config.ts", "eslint.config.ts"];
const codeFile = /\.(ts|tsx|css)$/;

function files(path: string): string[] {
  if (statSync(path).isFile()) return codeFile.test(path) ? [path] : [];
  if (path === folders) return [];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("scenario folders are data", () => {
  const names = folderScenarios.flatMap((scenario) => [scenario.id, scenario.name]);

  test("every folder loads through the one scenario path", () => {
    const ids = readdirSync(folders).filter((name) => statSync(join(folders, name)).isDirectory());
    expect(folderScenarios.map((scenario) => scenario.id)).toEqual(ids.sort());
    for (const scenario of folderScenarios) expect(scenario.busy).not.toBeNull();
  });

  test("no code names a scenario folder by its id or its name", () => {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9-])(${names.map(escape).join("|")})(?![A-Za-z0-9-])`,
      "i",
    );
    const found = scanned
      .flatMap((path) => files(join(root, path)))
      .filter((path) => !path.endsWith(".test.ts"))
      .flatMap((path) => {
        const match = pattern.exec(readFileSync(path, "utf8"));
        return match === null ? [] : [`${relative(root, path)}: ${match[0]}`];
      });
    expect(found).toEqual([]);
  });
});
