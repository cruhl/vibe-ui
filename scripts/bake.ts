import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import {
  closeRunSessions,
  createLog,
  ffmpegAvailable,
  ffmpegCommand,
  ffprobeCommand,
  keysFromEnvironment,
  launchBrowser,
  registerCleanup,
  root,
  seedKeys,
  sleep,
  startDevServer,
} from "./plumbing.ts";
import { measureReach, type Reach } from "./reach.ts";

const usage = `pnpm bake (--preset <id> | --idea "<idea>" | --all)
    [--depth N] [--write N] [--guesses N] [--cap MB] [--crf N] [--pool N] [--check] [--reach]
    [--skip <id,id>] [--port N] [--cards]

Bakes a scenario's moments to disk so a visitor's first clicks play with no loading. A bake is the
live engine running with nobody clicking: the same scheduler, agent turns, filming, capture,
boxing, checks and pruning as a live session, with the stage on the opening. It differs from a
live run only in where moments go (each one is written to the folder the moment it turns ready)
and how far it grows: --depth, --write and --guesses are the live knobs of the same names
(defaults 2, 3 and 5: the opening, five guesses below it and the likeliest of their own five
guesses filmed, one level more written), and past --cap megabytes of kept media (default 40)
nothing more is filmed and the report says so. The cap counts a loaded moment at its stored size
and a new one at its filmed size, and is checked as each moment turns ready, so builds already
running when it fills still land. A rerun keeps every moment whose content key and
checks still match and films only what is missing or stale; media no longer in the tree is
deleted.

Writes src/presets/<id>/moments/ (kept out of git): tree.json, and per moment <key>.mp4 and
<key>.jpg, and the picker's card art from the opening (the tree's root): its held frame as
card-320.jpg, card-640.jpg and card-960.jpg, and its clip as card.mp4, silent, 640 wide. Every clip is re-encoded once with H.264 at --crf (default 28, 0 to never) with its
audio copied, kept only when smaller and marked so a rerun never encodes it twice; ffmpeg comes
from the FFMPEG environment variable or else PATH. After every bake, and alone with --reach, Jev
spreads a plausible visitor's next choice over every boxed thing on each filmed held frame, and
the report gives, per click 1 to 6, the share of those paths still inside the filmed tree and
inside the written tree; the distributions go to .agent/pregen/reach/<id>.json. --check only
validates the saved tree against the current scenario and prints what is stale, starting no
session. --cards alone rewrites only the card art, of every baked folder or the --preset one. --idea writes a scenario from an idea first, as scenario-drive does, then bakes it into
its folder. --all bakes every scenario folder in turn, each in its own run with the same options,
except those --skip names, and ends with one size and reach table.

Starts its own dev server (default port 5405) and Playwright's bundled Chromium headless with
the keys from .env.local (pool of --pool sessions, default 5), ends every session and closes it
through the API as a backstop, and stops the server and the browser on every exit path.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.length === 0) {
  process.stdout.write(`${usage}\n`);
  process.exit(argv.length === 0 ? 1 : 0);
}
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const presetOption = option("preset");
const idea = option("idea");
const all = argv.includes("--all");
if (!all && !argv.includes("--cards") && (presetOption === null) === (idea === null)) {
  process.stdout.write(`${usage}\n`);
  process.exit(1);
}
const depth = Number(option("depth") ?? 2);
const write = Number(option("write") ?? 3);
const guesses = Number(option("guesses") ?? 5);
const cap = Number(option("cap") ?? 40);
const crf = Number(option("crf") ?? 28);
const pool = Number(option("pool") ?? 5);
const check = argv.includes("--check");
const reachOnly = argv.includes("--reach");
const cardsOnly = argv.includes("--cards");
const port = Number(option("port") ?? 5405);
const log = createLog();

const Report = z.object({
  scenario: z.string(),
  stale: z.array(z.string()),
  rootStale: z.boolean(),
  behind: z.boolean(),
  kept: z.number(),
  filmed: z.number(),
  written: z.number(),
  reboxed: z.number(),
  capped: z.boolean(),
  failed: z.string().nullable(),
});

const BakeState = z.object({
  phase: z.enum(["loading", "baking", "writing", "done", "failed"]),
  report: Report.nullable(),
});

const Tree = z.looseObject({
  moments: z.array(
    z.looseObject({
      key: z.string(),
      status: z.string(),
      clip: z.string().nullable(),
      held: z.string().nullable(),
      clipBytes: z.number().nullable(),
    }),
  ),
});

let browser: Browser | null = null;
let runID: string | null = null;

async function bakeState(page: Page): Promise<z.infer<typeof BakeState> | null> {
  const raw: unknown = await page.evaluate(() => window.vibeUI?.store.getState().bake ?? null);
  return BakeState.nullable().parse(raw);
}

const encodedMark = `vibe-ui crf ${String(crf)}`;

/** Whether a clip was already re-encoded by a bake, from the mark it carries. */
function encoded(path: string): boolean {
  try {
    return execFileSync(ffprobeCommand(), [
      "-v",
      "error",
      "-show_entries",
      "format_tags=comment",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ])
      .toString()
      .startsWith("vibe-ui crf");
  } catch {
    return false;
  }
}

/** Re-encodes a clip in place, keeping it only when smaller; returns its new size, or null. */
function shrink(path: string): number | null {
  const temporary = `${path}.tmp.mp4`;
  try {
    execFileSync(ffmpegCommand(), [
      "-v",
      "error",
      "-y",
      "-i",
      path,
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "copy",
      "-metadata",
      `comment=${encodedMark}`,
      temporary,
    ]);
    if (statSync(temporary).size >= statSync(path).size) {
      rmSync(temporary);
      return null;
    }
    renameSync(temporary, path);
    return statSync(path).size;
  } catch (error: unknown) {
    log(`re-encode failed for ${path}: ${String(error)}`);
    rmSync(temporary, { force: true });
    return null;
  }
}

/** The widths of the opening's held frame written for the picker's cards. */
const cardWidths = [320, 640, 960];
const cardFiles = new Set([...cardWidths.map((width) => `card-${String(width)}.jpg`), "card.mp4"]);

/** Writes the picker's card art from the tree's root: its held frame at each card width and a silent loop. */
function writeCards(folder: string): void {
  const treePath = join(folder, "tree.json");
  if (!existsSync(treePath)) return;
  const opening = Tree.parse(JSON.parse(readFileSync(treePath, "utf8"))).moments[0];
  if (opening === undefined || !ffmpegAvailable()) {
    log(`no card art for ${folder}: ${opening === undefined ? "empty tree" : "no ffmpeg"}`);
    return;
  }
  const run = (parameters: string[]) =>
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", ...parameters]);
  try {
    if (opening.held !== null)
      for (const width of cardWidths)
        run([
          "-i",
          join(folder, opening.held),
          "-vf",
          `scale=${String(width)}:-2:flags=lanczos`,
          "-q:v",
          "5",
          join(folder, `card-${String(width)}.jpg`),
        ]);
    if (opening.clip !== null)
      run([
        "-i",
        join(folder, opening.clip),
        "-an",
        "-vf",
        "scale=640:-2:flags=lanczos",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(folder, "card.mp4"),
      ]);
    const bytes = [...cardFiles]
      .filter((file) => existsSync(join(folder, file)))
      .map((file) => `${file} ${String(Math.round(statSync(join(folder, file)).size / 1000))} KB`);
    log(`card art: ${bytes.join(", ")}`);
  } catch (error: unknown) {
    log(`card art failed for ${folder}: ${String(error)}`);
  }
}

/**
 * Deletes media no longer named in the tree, re-encodes clips over the threshold and prints the
 * size of the folder.
 */
function finish(folder: string): void {
  const treePath = join(folder, "tree.json");
  if (!existsSync(treePath)) {
    log("no tree written");
    return;
  }
  const tree = Tree.parse(JSON.parse(readFileSync(treePath, "utf8")));
  const named = new Set(
    tree.moments.flatMap((moment) => [moment.clip, moment.held]).filter((name) => name !== null),
  );
  for (const file of readdirSync(folder))
    if (file !== "tree.json" && !named.has(file) && !cardFiles.has(file)) {
      rmSync(join(folder, file));
      log(`deleted ${file}, no longer in the tree`);
    }
  let changed = false;
  let before = 0;
  let after = 0;
  if (crf > 0 && !ffmpegAvailable()) log(`no ffmpeg (${ffmpegCommand()}) to re-encode clips`);
  else if (crf > 0)
    for (const moment of tree.moments) {
      if (moment.clip === null) continue;
      const path = join(folder, moment.clip);
      if (encoded(path)) continue;
      const size = statSync(path).size;
      const shrunk = shrink(path);
      if (shrunk === null) continue;
      before += size;
      after += shrunk;
      moment.clipBytes = shrunk;
      changed = true;
    }
  if (before > 0) log(`re-encoded clips at crf ${String(crf)}: ${mb(before)} to ${mb(after)}`);
  if (changed) writeFileSync(treePath, `${JSON.stringify(tree, null, 2)}\n`);
  writeCards(folder);
  const files = readdirSync(folder).map((file) => ({
    file,
    bytes: statSync(join(folder, file)).size,
  }));
  const sum = (filter: (file: string) => boolean) =>
    files.filter((item) => filter(item.file)).reduce((total, item) => total + item.bytes, 0);
  const ready = tree.moments.filter((moment) => moment.status === "ready").length;
  log(
    `size: ${mb(sum(() => true))} in all, clips ${mb(sum((file) => file.endsWith(".mp4")))}, held frames ${mb(sum((file) => file.endsWith(".jpg")))}, tree.json ${String(Math.round(sum((file) => file === "tree.json") / 1000))} KB; ${String(ready)} moments filmed, ${String(tree.moments.length - ready)} written only`,
  );
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;

function reportReach(scenario: string, reach: Reach | null): void {
  if (reach === null) {
    log(`${scenario}: no tree to measure`);
    return;
  }
  const percent = (values: number[]) =>
    values.map((value) => `${String(Math.round(value * 100))}%`).join(" ");
  log(
    `${scenario} reach by click (${String(reach.filmed)} filmed, ${String(reach.written)} written): filmed ${percent(reach.filmedReach)}; written ${percent(reach.writtenReach)}`,
  );
}

async function main(): Promise<boolean> {
  const server = await startDevServer({ port, extraArguments: ["--force"] });
  log(`dev server up on ${String(port)}`);
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await seedKeys(context, keysFromEnvironment());
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    log(`page error: ${error.message}`);
  });
  const parameters = new URLSearchParams({
    bake: check ? "check" : "1",
    depth: String(depth),
    write: String(write),
    guesses: String(guesses),
    pool: String(pool),
    bakeCap: String(cap),
  });
  let preset = presetOption;
  if (preset === null) {
    await page.goto(`${server.url}/?${parameters.toString()}`);
    await page.waitForSelector('[data-testid="scenario-idea"]', { timeout: 30_000 });
    await page.fill('[data-testid="scenario-idea"]', idea ?? "");
    await page.click('[data-testid="scenario-write"] button[type="submit"]');
    log(`submitted ${idea ?? ""}`);
    const deadline = Date.now() + 180_000;
    while (preset === null && Date.now() < deadline) {
      await sleep(500);
      preset = await page.evaluate(() => new URLSearchParams(location.search).get("preset"));
    }
    if (preset === null) throw new Error("the idea never became a scenario");
    log(`written as ${preset}`);
  } else {
    parameters.set("preset", preset);
    await page.goto(`${server.url}/?${parameters.toString()}`);
  }
  const deadline = Date.now() + 15 * 60_000;
  let last = "";
  for (;;) {
    runID ??= await page.evaluate(() => window.vibeUI?.summary().runID ?? null);
    const state = await bakeState(page).catch(() => null);
    if (state !== null && state.phase !== last) {
      last = state.phase;
      log(`bake ${state.phase}`);
    }
    if (state?.phase === "done" || state?.phase === "failed") {
      const report = state.report;
      if (report !== null) {
        log(
          `${report.scenario}: ${report.rootStale ? "whole tree stale (premise, world or canon changed)" : `${String(report.stale.length)} moments stale`}, ${String(report.kept)} kept, ${String(report.filmed)} filmed, ${String(report.written)} written, ${String(report.reboxed)} reboxed${report.behind ? ", agent instructions changed since the bake (tree served, marked behind)" : ""}${report.capped ? ", stopped at the size cap" : ""}`,
        );
        for (const key of report.stale) log(`stale: ${key}`);
        if (report.failed !== null) log(`failed: ${report.failed}`);
      }
      await page
        .evaluate(async () => {
          await window.vibeUI?.end("bake_done");
        })
        .catch(() => undefined);
      await sleep(1500);
      if (!check) {
        const folder = join(root, "src", "presets", preset, "moments");
        finish(folder);
        reportReach(preset, await measureReach(folder));
      }
      return state.phase === "done";
    }
    if (Date.now() > deadline) throw new Error("the bake did not finish within 15 minutes");
    await sleep(1000);
  }
}

/** Bakes every scenario folder in its own run of this script, then prints one size table. */
function bakeAll(): boolean {
  const folders = readdirSync(join(root, "src", "presets"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, "src", "presets", entry.name, "premise.md")),
    )
    .map((entry) => entry.name)
    .filter((name) => !(option("skip") ?? "").split(",").includes(name))
    .sort();
  const passed = argv.filter(
    (arg, index) => arg !== "--all" && arg !== "--skip" && argv[index - 1] !== "--skip",
  );
  let ok = true;
  for (const folder of folders) {
    log(`baking ${folder}`);
    try {
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          import.meta.filename,
          "--preset",
          folder,
          ...passed,
        ],
        { stdio: "inherit" },
      );
    } catch {
      ok = false;
      log(`${folder} failed`);
    }
  }
  let total = 0;
  for (const folder of folders) {
    const moments = join(root, "src", "presets", folder, "moments");
    const bytes = existsSync(moments)
      ? readdirSync(moments).reduce((sum, file) => sum + statSync(join(moments, file)).size, 0)
      : 0;
    total += bytes;
    const files = existsSync(moments) ? readdirSync(moments).length : 0;
    const reachPath = join(root, ".agent", "pregen", "reach", `${folder}.json`);
    const reach = existsSync(reachPath)
      ? z
          .looseObject({ filmedReach: z.array(z.number()), writtenReach: z.array(z.number()) })
          .parse(JSON.parse(readFileSync(reachPath, "utf8")))
      : null;
    const percent = (values: number[] | undefined) =>
      (values ?? [])
        .slice(0, 3)
        .map((value) => `${String(Math.round(value * 100))}%`)
        .join("/");
    log(
      `${folder.padEnd(24)} ${mb(bytes).padStart(9)} ${String(files).padStart(4)} files  reach filmed ${percent(reach?.filmedReach)} written ${percent(reach?.writtenReach)}`,
    );
  }
  log(`${"all".padEnd(20)} ${mb(total)}`);
  return ok;
}

mkdirSync(join(root, ".agent", "pregen"), { recursive: true });
if (cardsOnly)
  for (const id of presetOption === null
    ? readdirSync(join(root, "src", "presets"))
    : [presetOption])
    writeCards(join(root, "src", "presets", id, "moments"));
else if (reachOnly) {
  const ids = all
    ? readdirSync(join(root, "src", "presets")).filter((id) =>
        existsSync(join(root, "src", "presets", id, "moments", "tree.json")),
      )
    : [presetOption ?? ""];
  for (const id of ids)
    reportReach(id, await measureReach(join(root, "src", "presets", id, "moments")));
} else if (all) process.exitCode = bakeAll() ? 0 : 1;
else {
  const cleanup = registerCleanup({
    end: async () => {
      await browser?.close().catch(() => undefined);
      for (const line of await closeRunSessions(runID)) log(line);
    },
    timeoutMs: 20 * 60_000,
    log,
  });
  main()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((error: unknown) => {
      log(`failed: ${String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => cleanup("bake_exit"));
}
