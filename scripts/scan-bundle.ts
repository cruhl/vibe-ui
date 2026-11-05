import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readEnvironment, root } from "./plumbing.ts";

const usage = `pnpm scan

Reads every file of the production build in dist/ and fails (exit 1) if any .env.local value of 8
or more characters, or the dev server's keys path (/__dev/keys), appears in it. pnpm check runs it
after the build, and the deploy script runs it before it ships. Without .env.local only the keys
path is checked.`;

if (process.argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const values = Object.entries(readEnvironment()).filter(([, value]) => value.length >= 8);

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

if (!existsSync(join(root, "dist"))) {
  process.stderr.write("no dist/ to scan: run pnpm build first\n");
  process.exit(1);
}
const built = files(join(root, "dist"));
const leaks = built.flatMap((path) => {
  const text = readFileSync(path, "latin1");
  return values.filter(([, value]) => text.includes(value)).map(([name]) => `${name} in ${path}`);
});
const devPaths = built.filter((path) => readFileSync(path, "latin1").includes("/__dev/keys"));

if (leaks.length > 0 || devPaths.length > 0) {
  for (const leak of leaks) process.stderr.write(`secret value found: ${leak}\n`);
  for (const path of devPaths) process.stderr.write(`dev-only keys path found in ${path}\n`);
  process.exit(1);
}
process.stdout.write(
  `bundle scan: ${built.length} files clean of ${values.length} .env.local values and the dev keys path\n`,
);
