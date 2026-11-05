import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { z } from "zod";
import {
  createLog,
  ffmpegCommand,
  launchBrowser,
  registerCleanup,
  root,
  seedKeys,
  sleep,
  startDevServer,
  type SavedKeys,
} from "./plumbing.ts";
import { buildKit } from "./replay-kit.ts";

const bundleFiles = ["session.json", "run-log.jsonl", "recording.webm", "clips", "inputs"];

/** The newest session bundle the dev server saved that holds everything a replay kit needs. */
function newestBundle(): string | null {
  const sessions = join(root, ".agent", "sessions");
  if (!existsSync(sessions)) return null;
  return (
    readdirSync(sessions)
      .sort()
      .reverse()
      .map((name) => join(sessions, name))
      .find((bundle) => bundleFiles.every((file) => existsSync(join(bundle, file)))) ?? null
  );
}

const viewports = {
  wide: { width: 1440, height: 900, deviceScaleFactor: 1, touch: false },
  narrow: { width: 390, height: 844, deviceScaleFactor: 1, touch: true },
} as const;
type ViewportName = keyof typeof viewports;

const shotNames = [
  "keys",
  "picker",
  "session",
  "controls",
  "debug",
  "error-refused",
  "error-slow",
  "error-response",
] as const;
type ShotName = (typeof shotNames)[number];

const usage = `pnpm record-ui [--round <name>] [--shot <name>]... [--viewport wide|narrow]...
    [--bundle <session bundle dir>] [--delays <scale>] [--clicks <n>] [--parallel <n>] [--port N]

Records the app's chrome in every state that matters, headless, with no real provider call: each
shot opens the real app in its own Chromium context with Playwright video on, drives it, and saves
stills at named moments. Session shots replay a captured session bundle through the app's mock
seams (?kit=<runID>, see src/eval/kit.ts): the mock Omni plays the recorded footage after the
measured build times stretched by --delays (default 0.3; 1 is as measured, 0 is instant), Jev
answers with the recorded boxes, the agent replays its recorded turns. The dev server saves a
bundle for every session it serves in .agent/sessions/<runID>/, and --bundle defaults to the
newest one with a recording, clips and inputs, so play one session with pnpm dev first. The kit is built on first use with
scripts/replay-kit.ts. Every real provider host is blocked and /__dev/keys answers nothing, so no
real key reaches the page and no Reactor session can open; the page gets placeholder keys.

Shots (default all):
  keys            the bring-your-own keys screen (?keys=1), empty then filled
  picker          the world picker (?worlds), a card hovered, an idea typed into "Make it", the
                  create flow writing, then the writer's error (its call is answered 401 after 3 s)
  session         opening busy state, first frame, held frame, then --clicks recorded clicks (default
                  3) each with hover, press acknowledgement, wait and answer
  controls        control bar revealed, pause and play, the direct message box typed and sent, its
                  answer, then End to the ended picker
  debug           ?debug=1: boxes, labels and the debug panel through one click
  error-refused   the model refuses the opening (?mockFault=refuse:1)
  error-slow      every clip after the opening builds slowly, so a click shows the slow phase
  error-response  every enqueue after the opening is refused, so a click fails
Viewports (default both): wide 1440x900, narrow 390x844 at 2x.

Writes .agent/design/recordings/<round>/<shot>-<viewport>.mp4, stills
<shot>-<viewport>-<nn>-<moment>.png, and index.md listing every video with the second each moment
and action happened (each shot's part also in notes/, so runs into the same round add up). Shots run
--parallel at a time (default 2; more starves the mock video under load). Starts its own dev server
(default port 5403) and Playwright's bundled Chromium, and stops both on every exit path. Videos
are encoded with ffmpeg, taken from the FFMPEG environment variable or else found on PATH. Exits 1
when a shot fails (or runs past three minutes); the other shots still run.`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const options = (name: string) =>
  argv.flatMap((arg, index) =>
    arg === `--${name}` && argv[index + 1] !== undefined ? [argv[index + 1] ?? ""] : [],
  );
const round = option("round") ?? new Date().toISOString().replace(/[:.]/g, "-");
const port = Number(option("port") ?? 5403);
const delays = Number(option("delays") ?? 0.3);
const clicks = Number(option("clicks") ?? 3);
const parallel = Number(option("parallel") ?? 2);
const shotLimitMs = 180_000;
const bundle = option("bundle") ?? newestBundle();
const requestedShots = options("shot");
const unknownShot = requestedShots.find((name) => !shotNames.some((known) => known === name));
const requestedViewports = options("viewport");
const unknownViewport = requestedViewports.find((name) => !(name in viewports));
if (unknownShot !== undefined || unknownViewport !== undefined) {
  process.stdout.write(`unknown ${unknownShot ?? unknownViewport}\n\n${usage}\n`);
  process.exit(1);
}
const shots = shotNames.filter(
  (name) => requestedShots.length === 0 || requestedShots.includes(name),
);
const viewportNames: readonly ViewportName[] = ["wide", "narrow"];
const sizes = viewportNames.filter(
  (name) => requestedViewports.length === 0 || requestedViewports.includes(name),
);
const output = join(root, ".agent", "design", "recordings", round);
mkdirSync(output, { recursive: true });

const log = createLog(join(output, "log.txt"));

const Box = z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() });
type Box = z.infer<typeof Box>;
const Snapshot = z.object({
  phase: z.string(),
  heldReady: z.boolean(),
  locked: z.string().nullable(),
  inputs: z.array(
    z.object({
      label: z.string(),
      outcome: z.string(),
      firstFrameAt: z.number().nullable(),
      failed: z.string().nullable(),
    }),
  ),
  boxes: z.array(z.object({ elementID: z.string(), presence: z.number(), box: Box })),
  video: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable(),
  error: z.string().nullable(),
});
type Snapshot = z.infer<typeof Snapshot>;

async function snapshot(page: Page): Promise<Snapshot | null> {
  const raw: unknown = await page.evaluate(() => {
    const controller = window.vibeUI;
    if (controller === undefined) return null;
    const state = controller.store.getState();
    const rect = controller.video?.getBoundingClientRect() ?? null;
    return {
      phase: state.phase,
      heldReady: state.heldReady,
      locked: state.locked,
      inputs: state.inputs.map((input) => ({
        label: input.label,
        outcome: input.outcome,
        firstFrameAt: input.firstFrameAt,
        failed: input.failed,
      })),
      boxes: state.boxes.map((box) => ({
        elementID: box.elementID,
        presence: box.presence,
        box: box.box,
      })),
      video:
        rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      error: state.error,
    };
  });
  return Snapshot.nullable().parse(raw);
}

async function waitFor(
  page: Page,
  label: string,
  predicate: (state: Snapshot) => boolean,
  timeoutMs: number,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await snapshot(page).catch(() => null);
    if (state !== null && predicate(state)) return state;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

/** The point of a box nearest its center that lies outside every other box, or its center. */
function openPoint(target: Box, others: readonly Box[]): { x: number; y: number } {
  const center = { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 };
  const steps = Array.from({ length: 11 }, (_, i) => 0.05 + i * 0.09);
  const inside = (point: { x: number; y: number }, box: Box) =>
    point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  return (
    steps
      .flatMap((across) =>
        steps.map((down) => ({
          x: target.left + across * (target.right - target.left),
          y: target.top + down * (target.bottom - target.top),
        })),
      )
      .filter((point) => !others.some((box) => inside(point, box)))
      .sort(
        (first, second) =>
          Math.hypot(first.x - center.x, first.y - center.y) -
          Math.hypot(second.x - center.x, second.y - center.y),
      )[0] ?? center
  );
}

const Manifest = z.object({
  runID: z.string(),
  preset: z.string(),
  inputs: z.array(z.object({ kind: z.string(), elementID: z.string().nullable() })),
});
type Manifest = z.infer<typeof Manifest>;

interface Moment {
  name: string;
  seconds: number;
  still: string | null;
}

interface Recording {
  page: Page;
  shot: ShotName;
  viewport: ViewportName;
  startedAt: number;
  moments: Moment[];
  mark: (name: string) => Promise<void>;
  note: (name: string) => void;
}

const placeholderKeys: SavedKeys = {
  reactor: "cheat-reactor",
  openAI: "cheat-openai",
  typesafe: "cheat-typesafe",
  fal: "cheat-fal",
};
const providerHosts = [
  "api.reactor.inc",
  "api.openai.com",
  "api.typesafe.ai",
  "fal.run",
  "openrouter.ai",
  "queue.fal.run",
];

async function guard(context: BrowserContext, shot: ShotName): Promise<void> {
  await context.route("**/__dev/keys", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await context.route(
    (url) =>
      providerHosts.some((host) => url.hostname.endsWith(host)) || url.pathname.startsWith("/jev"),
    async (route) => {
      const url = route.request().url();
      if (shot === "picker" && url.startsWith("https://api.openai.com/")) {
        await sleep(3000);
        await route
          .fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({
              error: { message: "Incorrect API key provided.", type: "invalid_request_error" },
            }),
          })
          .catch(() => undefined);
        return;
      }
      log(
        `blocked a real provider call: ${route.request().method()} ${url.slice(0, 90)} ${(route.request().postData() ?? "").slice(0, 160)}`,
      );
      await route.abort().catch(() => undefined);
    },
  );
}

function sessionURL(manifest: Manifest, extra: Record<string, string> = {}): string {
  const parameters = new URLSearchParams({
    preset: manifest.preset,
    kit: manifest.runID,
    autostart: "1",
    delays: String(delays),
    ...extra,
  });
  return `http://127.0.0.1:${port}/?${parameters.toString()}`;
}

async function firstFrame(page: Page): Promise<Snapshot> {
  return waitFor(
    page,
    "the opening's first frame",
    (state) => state.inputs[0]?.firstFrameAt != null || state.inputs[0]?.failed != null,
    60_000,
  );
}

async function heldWithBoxes(page: Page): Promise<Snapshot> {
  return waitFor(
    page,
    "a held frame with boxes",
    (state) =>
      state.heldReady &&
      state.locked === null &&
      state.boxes.some((box) => box.presence >= 0.5) &&
      state.inputs.at(-1)?.firstFrameAt != null,
    60_000,
  );
}

async function glide(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 14 });
}

/** Presses a point: a tap on a touch viewport, else a mouse press and release. */
async function tap(page: Page, x: number, y: number): Promise<void> {
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await page.touchscreen.tap(x, y);
    return;
  }
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
}

/** Moves to a control the way a person would (revealing a hidden bar on the way) and presses it. */
async function press(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const box = await button.boundingBox();
    if (box !== null) {
      await glide(page, box.x + box.width / 2, box.y + box.height / 2);
      await sleep(250);
      await tap(page, box.x + box.width / 2, box.y + box.height / 2);
      return;
    }
    if (Date.now() > deadline) throw new Error(`no ${name} button`);
    await sleep(200);
  }
}

/** Moves to an element's open point, presses it and follows it to its answer. */
async function clickThrough(
  recording: Recording,
  wanted: string | null,
  index: number,
): Promise<void> {
  const { page } = recording;
  let state = await heldWithBoxes(page);
  const live = state.boxes.filter((box) => box.presence >= 0.5);
  const target = live.find((box) => box.elementID === wanted) ?? live[index % live.length];
  if (target === undefined || state.video === null) throw new Error("nothing boxed to click");
  const point = openPoint(
    target.box,
    live.filter((box) => box !== target).map((box) => box.box),
  );
  const x = state.video.x + point.x * state.video.width;
  const y = state.video.y + point.y * state.video.height;
  await glide(page, x, y);
  await sleep(350);
  await recording.mark(`click${index + 1}-hover-${target.elementID}`);
  const before = state.inputs.length;
  await tap(page, x, y);
  recording.note(`click${index + 1} pressed ${target.elementID}`);
  await sleep(120);
  await recording.mark(`click${index + 1}-ack`);
  await sleep(1100);
  await recording.mark(`click${index + 1}-wait`);
  state = await waitFor(
    page,
    "the click's answer",
    (current) =>
      current.inputs.length > before &&
      (current.inputs.at(-1)?.firstFrameAt != null || current.inputs.at(-1)?.failed != null),
    60_000,
  );
  const answered = state.inputs.at(-1);
  recording.note(
    `click${index + 1} ${answered?.failed == null ? `answered (${answered?.outcome ?? "?"})` : `failed: ${answered.failed}`}`,
  );
  await sleep(1200);
  await recording.mark(`click${index + 1}-answer`);
}

type ShotRun = (recording: Recording, manifest: Manifest) => Promise<void>;

const runs: Record<ShotName, ShotRun> = {
  keys: async (recording) => {
    const { page } = recording;
    await page.goto(`http://127.0.0.1:${port}/?keys=1`);
    await page.locator(".keys-screen").waitFor();
    await sleep(800);
    await recording.mark("empty");
    for (const [name, value] of [
      ["reactor", "rk_live_example_key"],
      ["openAI", "sk-example-key"],
      ["typesafe", "ts_example_key"],
    ] as const) {
      await page.locator(`input[name="${name}"]`).click();
      await page.keyboard.type(value, { delay: 25 });
    }
    await sleep(300);
    await recording.mark("filled");
    const start = page.locator(".keys-start");
    const box = await start.boundingBox();
    if (box !== null) await glide(page, box.x + box.width / 2, box.y + box.height / 2);
    await sleep(500);
    await recording.mark("start-hover");
  },
  picker: async (recording) => {
    const { page } = recording;
    await page.goto(`http://127.0.0.1:${port}/?worlds`);
    await page.locator('[data-testid="scenario-picker"]').waitFor();
    await sleep(1200);
    await recording.mark("home");
    const card = page.locator(".picker-card").first();
    const box = await card.boundingBox();
    if (box !== null) await glide(page, box.x + box.width / 2, box.y + box.height / 3);
    await sleep(500);
    await recording.mark("card-hover");
    await page.locator('[data-testid="scenario-idea"]').click();
    await page.keyboard.type("a submarine diner where the fish order lunch", { delay: 30 });
    await sleep(300);
    await recording.mark("idea-typed");
    await page.keyboard.press("Enter");
    recording.note("idea submitted");
    await sleep(900);
    await recording.mark("idea-writing");
    await page
      .locator('[data-testid="scenario-error"]')
      .waitFor({ timeout: 30_000 })
      .catch(() => undefined);
    await sleep(800);
    await recording.mark("idea-error");
  },
  session: async (recording, manifest) => {
    const { page } = recording;
    await page.goto(sessionURL(manifest));
    await sleep(700);
    await recording.mark("opening");
    await firstFrame(page);
    recording.note("opening first frame");
    await sleep(900);
    await recording.mark("first-frame");
    await heldWithBoxes(page);
    await sleep(600);
    await recording.mark("held");
    const wanted = manifest.inputs.filter((input) => input.kind === "click");
    for (let i = 0; i < clicks; i++) await clickThrough(recording, wanted[i]?.elementID ?? null, i);
  },
  controls: async (recording, manifest) => {
    const { page } = recording;
    await page.goto(sessionURL(manifest));
    await heldWithBoxes(page);
    const size = page.viewportSize() ?? { width: 800, height: 600 };
    await glide(page, size.width / 2, size.height / 2);
    await glide(page, size.width / 2 + 40, size.height / 3);
    await sleep(300);
    await recording.mark("controls");
    await press(page, "Pause");
    recording.note("paused");
    await sleep(900);
    await recording.mark("paused");
    await press(page, "Play");
    recording.note("resumed");
    await heldWithBoxes(page).catch(() => null);
    await sleep(600);
    await press(page, "Type a message");
    await sleep(400);
    await recording.mark("message-open");
    await page.getByRole("textbox", { name: "Tell the world what to do" }).click();
    await page.keyboard.type("make it rain lemons", { delay: 35 });
    await recording.mark("message-typed");
    const before = (await snapshot(page))?.inputs.length ?? 0;
    await page.keyboard.press("Enter");
    recording.note("message sent");
    await sleep(1300);
    await recording.mark("message-wait");
    await waitFor(
      page,
      "the message's answer",
      (state) =>
        state.inputs.length > before &&
        (state.inputs.at(-1)?.firstFrameAt != null || state.inputs.at(-1)?.failed != null),
      60_000,
    ).catch(() => null);
    await sleep(1500);
    await recording.mark("message-answer");
    await glide(page, size.width / 2, size.height / 4);
    await press(page, "Shut down");
    await sleep(300);
    await recording.mark("end-armed");
    const confirm = page.getByRole("button", { name: "Confirm end", exact: true });
    const confirmBox = await confirm.boundingBox();
    if (confirmBox !== null)
      await tap(page, confirmBox.x + confirmBox.width / 2, confirmBox.y + confirmBox.height / 2);
    recording.note("end pressed");
    await sleep(500);
    await recording.mark("ending");
    await page.locator('[data-testid="scenario-picker"]').waitFor({ timeout: 20_000 });
    await sleep(1500);
    await recording.mark("ended");
  },
  debug: async (recording, manifest) => {
    const { page } = recording;
    await page.goto(sessionURL(manifest, { debug: "1" }));
    await sleep(700);
    await recording.mark("opening");
    await heldWithBoxes(page);
    await sleep(600);
    await recording.mark("held");
    const wanted = manifest.inputs.find((input) => input.kind === "click")?.elementID ?? null;
    await clickThrough(recording, wanted, 0);
  },
  "error-refused": async (recording, manifest) => {
    const { page } = recording;
    await page.goto(sessionURL(manifest, { mockFault: "refuse:1" }));
    await sleep(800);
    await recording.mark("opening");
    await waitFor(page, "the refusal", (state) => state.error !== null, 20_000).catch(() => null);
    recording.note("opening refused");
    await sleep(1200);
    await recording.mark("refused");
    await sleep(4000);
    await recording.mark("refused-later");
  },
  "error-slow": async (recording, manifest) => {
    const { page } = recording;
    const slow = Array.from({ length: 60 }, (_, i) => `slow:${i + 2}:40`).join(",");
    await page.goto(sessionURL(manifest, { mockFault: slow }));
    await heldWithBoxes(page);
    await sleep(500);
    const state = await snapshot(page);
    const target = state?.boxes.find((box) => box.presence >= 0.5);
    if (target === undefined || state?.video == null) throw new Error("nothing boxed");
    const point = openPoint(target.box, []);
    await glide(
      page,
      state.video.x + point.x * state.video.width,
      state.video.y + point.y * state.video.height,
    );
    await tap(
      page,
      state.video.x + point.x * state.video.width,
      state.video.y + point.y * state.video.height,
    );
    recording.note(`pressed ${target.elementID}`);
    let previous = 0;
    for (const seconds of [1, 4, 9, 16, 22, 30]) {
      await sleep((seconds - previous) * 1000);
      previous = seconds;
      await recording.mark(`wait-${seconds}s`);
    }
  },
  "error-response": async (recording, manifest) => {
    const { page } = recording;
    const refused = Array.from({ length: 80 }, (_, i) => `refuse:${i + 2}`).join(",");
    await page.goto(sessionURL(manifest, { mockFault: refused }));
    await heldWithBoxes(page);
    await sleep(500);
    await clickThrough(recording, null, 0).catch((error: unknown) => {
      recording.note(`click did not answer: ${String(error)}`);
    });
    await sleep(3000);
    await recording.mark("after-failure");
  },
};

async function record(
  browser: Browser,
  shot: ShotName,
  viewport: ViewportName,
  manifest: Manifest,
): Promise<{ video: string | null; moments: Moment[]; error: string | null }> {
  const size = viewports[viewport];
  const scratch = join(output, ".video", `${shot}-${viewport}`);
  rmSync(scratch, { recursive: true, force: true });
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.deviceScaleFactor,
    hasTouch: size.touch,
    isMobile: size.touch,
    recordVideo: { dir: scratch, size: { width: size.width, height: size.height } },
  });
  await guard(context, shot);
  if (shot !== "keys") await seedKeys(context, placeholderKeys);
  const page = await context.newPage();
  const startedAt = Date.now();
  const moments: Moment[] = [];
  const seconds = () => Math.round((Date.now() - startedAt) / 100) / 10;
  page.on("pageerror", (error) => {
    log(`${shot}-${viewport} page error: ${error.message}`);
  });
  const recording: Recording = {
    page,
    shot,
    viewport,
    startedAt,
    moments,
    mark: async (name) => {
      const stills = moments.filter((moment) => moment.still !== null).length;
      const file = `${shot}-${viewport}-${String(stills + 1).padStart(2, "0")}-${name}.png`;
      const at = seconds();
      const taken = await page
        .screenshot({ path: join(output, file), timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      moments.push({
        name: taken ? name : `${name} (no still)`,
        seconds: at,
        still: taken ? file : null,
      });
    },
    note: (name) => {
      moments.push({ name, seconds: seconds(), still: null });
    },
  };
  let error: string | null = null;
  try {
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      runs[shot](recording, manifest),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`shot ran past ${shotLimitMs / 1000} s`));
        }, shotLimitMs);
      }),
    ]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  } catch (caught: unknown) {
    error = String(caught);
    log(`${shot}-${viewport} failed: ${error}`);
    await recording.mark("failure").catch(() => undefined);
  }
  await sleep(500);
  const video = page.video();
  await page.close().catch(() => undefined);
  await context.close().catch(() => undefined);
  const source = await video?.path().catch(() => null);
  if (source == null || !existsSync(source)) return { video: null, moments, error };
  const file = `${shot}-${viewport}.mp4`;
  execFileSync(
    ffmpegCommand(),
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      source,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "22",
      "-preset",
      "veryfast",
      "-vf",
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
      join(output, file),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  rmSync(scratch, { recursive: true, force: true });
  return { video: file, moments, error };
}

const finish = registerCleanup({ timeoutMs: null, log });

async function main(): Promise<number> {
  log(`round ${round}: ${shots.join(", ")} at ${sizes.join(", ")}, delays x${delays}`);
  if (bundle === null)
    throw new Error(
      "no session bundle in .agent/sessions/ with a recording, clips and inputs: play one session with pnpm dev, or pass --bundle",
    );
  await startDevServer({ port, detached: true });
  const kitDirectory = buildKit(bundle, root);
  const manifest = Manifest.parse(
    JSON.parse(readFileSync(join(kitDirectory, "manifest.json"), "utf8")),
  );
  log(`kit ${manifest.runID} (${manifest.preset})`);
  const browser = await launchBrowser();
  const notes = join(output, "notes");
  mkdirSync(notes, { recursive: true });
  const writeIndex = () => {
    const sections = shotNames.flatMap((shot) =>
      viewportNames.flatMap((viewport) => {
        const path = join(notes, `${shot}-${viewport}.md`);
        return existsSync(path) ? [readFileSync(path, "utf8")] : [];
      }),
    );
    writeFileSync(
      join(output, "index.md"),
      [
        `# Recordings ${round}`,
        "",
        `Kit ${manifest.runID} (${manifest.preset}).`,
        "",
        ...sections,
      ].join("\n"),
    );
  };
  const queue = shots.flatMap((shot) => sizes.map((viewport) => ({ shot, viewport })));
  let failures = 0;
  const worker = async () => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const { shot, viewport } = job;
      log(`recording ${shot} at ${viewport}`);
      const result = await record(browser, shot, viewport, manifest);
      if (result.error !== null) failures++;
      const lines = [`## ${shot} at ${viewport}`, "", `Delays x${delays}.`, ""];
      lines.push(result.video === null ? "No video." : `Video: ${result.video}`, "");
      if (result.error !== null) lines.push(`Failed: ${result.error}`, "");
      for (const moment of result.moments)
        lines.push(
          `- ${moment.seconds.toFixed(1)} s: ${moment.name}${moment.still === null ? "" : ` (${moment.still})`}`,
        );
      lines.push("");
      writeFileSync(join(notes, `${shot}-${viewport}.md`), lines.join("\n"));
      writeIndex();
      log(`done ${shot} at ${viewport}${result.error === null ? "" : " (failed)"}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  rmSync(join(output, ".video"), { recursive: true, force: true });
  log(`wrote ${output}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await finish("done");
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    log(`failed: ${String(error)}`);
    await finish("failed");
    process.exit(1);
  });
