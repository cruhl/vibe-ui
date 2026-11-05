import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseEnv } from "node:util";

const usage = `pnpm ship [--dry-run] [--secrets] [--hosted on|off]
    [--wrangler <path>] [--env-file <path>]

Builds the page, proves the bundle is safe to publish, and deploys it as the Cloudflare Worker
named in deploy/wrangler.jsonc (vibe-ui on the account's workers.dev subdomain). The Worker serves
dist/ as static assets, proxies /jev for pages on their visitor's own keys, and serves hosted play
under /api with keys it holds as secrets (deploy/worker.ts says what each route allows).

Before anything is uploaded the build must pass every check, or the script exits 1:
  - pnpm run scan: no .env.local value and no dev keys path anywhere in dist/
  - no key-shaped string (OpenAI, OpenRouter, Reactor, TypeSafe or fal shapes) in any text file
  - every baked moment under src/presets/*/moments/ is in dist/assets/ (none baked is fine)

--dry-run      build, check and bundle the Worker without uploading it
--secrets      after the deploy, set the Worker's secrets from .env.local, piped to wrangler on
               stdin and never printed: REACTOR_API_KEY, OPENAI_API_KEY and TYPESAFE_API_KEY as
               themselves, and FAL_PRODUCTION_KEY as the Worker's FAL_KEY. .env.local's own
               FAL_KEY is the development key and is never uploaded; the script refuses to run
               when FAL_PRODUCTION_KEY is missing or equals FAL_KEY. TURNSTILE_SECRET_KEY (the
               widget whose site key is the TURNSTILE_SITE_KEY var) goes as itself, and a fresh
               random PASS_SECRET signs hosted-play passes, so each --secrets run voids every
               pass issued before it (pages earn a new one without a visible challenge).
--hosted       the kill switch: off deploys with every hosted route answering 503 (the
               HOSTED var); on (the default) serves hosted play
--wrangler     the wrangler executable (default: wrangler on PATH; npx wrangler works too)
--env-file     a dotenv file to read CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from;
               nothing else in it is read. Without it wrangler uses its own login or the
               environment.`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const root = join(import.meta.dirname, "..");
const dryRun = argv.includes("--dry-run");
const withSecrets = argv.includes("--secrets");
const hosted = option("hosted") ?? "on";
const wrangler = option("wrangler") ?? "wrangler";
const environmentFile = option("env-file");

const fail = (message: string): never => {
  process.stderr.write(`deploy: ${message}\n`);
  process.exit(1);
};

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const keyShapes = [
  /sk-(?:proj-|or-v1-|ant-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:rk|apikey|fal_sk)_[A-Za-z0-9_-]{20,}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/,
];
const textExtensions = new Set([".js", ".mjs", ".css", ".html", ".json", ".txt", ".svg", ".md"]);

function checkKeyShapes(dist: string[]): void {
  const found = dist
    .filter((path) => textExtensions.has(extname(path)))
    .flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return keyShapes.filter((shape) => shape.test(text)).map((shape) => `${shape} in ${path}`);
    });
  if (found.length > 0) fail(`key-shaped strings in the bundle:\n  ${found.join("\n  ")}`);
  process.stdout.write(`key shapes: ${dist.length} files clean\n`);
}

function checkMoments(dist: string[]): void {
  const presets = join(root, "src", "presets");
  const baked = readdirSync(presets).flatMap((scenario) => {
    const moments = join(presets, scenario, "moments");
    return existsSync(moments)
      ? readdirSync(moments)
          .filter((name) => [".mp4", ".jpg"].includes(extname(name)))
          .map((name) => ({ scenario, name, size: statSync(join(moments, name)).size }))
      : [];
  });
  const shipped = new Set(
    dist.map((path) => {
      const name = basename(path);
      return `${name.replace(/-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/, "")}${extname(name)}`;
    }),
  );
  const missing = baked.filter((moment) => moment.size > 4096 && !shipped.has(moment.name));
  if (missing.length > 0)
    fail(
      `baked moments missing from dist/assets:\n  ${missing.map((moment) => `${moment.scenario}/${moment.name}`).join("\n  ")}`,
    );
  const megabytes = baked.reduce((sum, moment) => sum + moment.size, 0) / 1024 / 1024;
  const scenarios = new Set(baked.map((moment) => moment.scenario)).size;
  process.stdout.write(
    `moments: ${baked.length} baked files (${megabytes.toFixed(1)} MB, ${scenarios} scenarios) all in dist/assets\n`,
  );
}

function credentials(): Record<string, string> {
  if (environmentFile === null) return {};
  if (!existsSync(environmentFile)) fail(`no env file at ${environmentFile}`);
  const parsed = parseEnv(readFileSync(environmentFile, "utf8"));
  return Object.fromEntries(
    ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].flatMap((name) => {
      const value = parsed[name];
      return value === undefined || value === "" ? [] : [[name, value]];
    }),
  );
}

if (hosted !== "on" && hosted !== "off") fail("--hosted takes on or off");

const secretNames = [
  "REACTOR_API_KEY",
  "OPENAI_API_KEY",
  "TYPESAFE_API_KEY",
  "TURNSTILE_SECRET_KEY",
] as const;

function secrets(): Record<string, string> {
  const path = join(root, ".env.local");
  if (!existsSync(path)) fail("--secrets needs .env.local");
  const local = parseEnv(readFileSync(path, "utf8"));
  const missing = secretNames.filter((name) => (local[name] ?? "") === "");
  if (missing.length > 0) fail(`.env.local lacks ${missing.join(", ")}`);
  const production = local.FAL_PRODUCTION_KEY ?? "";
  if (production === "") fail(".env.local lacks FAL_PRODUCTION_KEY; FAL_KEY is never uploaded");
  if (production === (local.FAL_KEY ?? ""))
    fail("FAL_PRODUCTION_KEY equals the development FAL_KEY");
  return {
    ...Object.fromEntries(secretNames.map((name) => [name, local[name] ?? ""])),
    FAL_KEY: production,
    PASS_SECRET: randomBytes(32).toString("base64url"),
  };
}

const uploads = withSecrets ? secrets() : null;
execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["run", "scan"], { cwd: root, stdio: "inherit" });
const dist = files(join(root, "dist"));
checkKeyShapes(dist);
checkMoments(dist);
const config = join(root, "deploy", "wrangler.jsonc");
const environment = { ...process.env, ...credentials() };
const deployed = spawnSync(
  wrangler,
  ["deploy", "--config", config, "--var", `HOSTED:${hosted}`, ...(dryRun ? ["--dry-run"] : [])],
  { cwd: root, stdio: "inherit", env: environment },
);
if (deployed.error !== undefined) fail(`could not run ${wrangler}: ${deployed.error.message}`);
if (deployed.status !== 0) fail(`wrangler exited ${String(deployed.status)}`);
process.stdout.write(`deployed with hosted play ${hosted}\n`);
if (uploads !== null && !dryRun) {
  const put = spawnSync(wrangler, ["secret", "bulk", "--config", config], {
    cwd: root,
    input: JSON.stringify(uploads),
    stdio: ["pipe", "ignore", "inherit"],
    env: environment,
  });
  if (put.status !== 0) fail(`wrangler secret bulk exited ${String(put.status)}`);
  process.stdout.write(`secrets set: ${Object.keys(uploads).join(", ")}\n`);
}
