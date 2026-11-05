import { execFileSync } from "node:child_process";
import { linkWithKeys } from "../src/keys/link.ts";
import { keysFromEnvironment } from "./plumbing.ts";

const usage = `pnpm key-link [--base <url>] [--print]

Builds a link that opens the app with every key from .env.local already saved, and copies it to
the clipboard. The keys ride in the URL fragment, which browsers never send to a server; the page
saves them in that browser and strips them from the address bar. Anyone holding the link holds
the keys, so share it only with people who should use them.

--base   the page to open (default: https://vibe-ui.connerruhl.workers.dev/)
--print  print the link instead of copying it`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const baseIndex = argv.indexOf("--base");
const base =
  baseIndex === -1 ? "https://vibe-ui.connerruhl.workers.dev/" : (argv[baseIndex + 1] ?? "");
const link = linkWithKeys(base, keysFromEnvironment());
if (argv.includes("--print")) process.stdout.write(`${link}\n`);
else {
  execFileSync("pbcopy", { input: link });
  process.stdout.write(`Copied a key link for ${base} (${link.length} characters).\n`);
}
