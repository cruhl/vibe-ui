import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import {
  closeRunSessions,
  createLog,
  launchBrowser,
  registerCleanup,
  root,
  sleep,
  startDevServer,
} from "./plumbing.ts";

const usage = `pnpm drive <ready|probe|loop> [options]

Starts its own dev server, opens the app in headless Chromium with ?autostart and the keys in
.env.local, and drives a session with the real mouse: each press is followed by a second press
while its answer is pending and a press on no box, so every kind of press is logged.

Modes:
  ready   screenshot once the Omni session reaches ready, then end
  probe   wait for the opening clip and the boxes on its held last frame, screenshot, end
  loop    for --seconds, click in a repeating pattern: a guessed element once its clip is built
          (a hit; every other hit prefers a clip built on a helper session), an element nobody
          guessed (a miss), and a click two seconds into a playing clip (a mid-clip cut); the
          summary splits click to first frame by hit and miss

Options:
  --seconds <n>     how long loop runs (default 200)
  --instruct "a|b"  before the click pattern, give the world each instruction (split on |) as
                    a direct message, waiting for the held frame after each
  --omni mock       film with the stand-in session instead of Reactor
  --pool <n>        Omni sessions (default: the app's, 5; 1 is the single-session path)
  --headed          show the browser
  --port <n>        dev server port (default 5402)

Writes screenshots and the summary to .agent/proof/<mode>-<time>/. Every exit path ends every
session with a non-recoverable disconnect, then closes it through the Reactor API as a backstop,
and stops the server and the browser. A hard timeout exits 2; any stalled wait exits 1; a run
where any input failed exits 3.`;

const mode = process.argv[2];
const secondsIndex = process.argv.indexOf("--seconds");
const loopSeconds = secondsIndex === -1 ? 200 : Number(process.argv[secondsIndex + 1]);
const headed = process.argv.includes("--headed");
if (mode !== "ready" && mode !== "probe" && mode !== "loop") {
  process.stdout.write(`${usage}\n`);
  process.exit(mode === "--help" ? 0 : 1);
}

const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 5402 : Number(process.argv[portIndex + 1]);
const proofDirectory = join(
  root,
  ".agent",
  "proof",
  `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(proofDirectory, { recursive: true });

const log = createLog();

interface Snapshot {
  phase: string;
  sessionStatus: string;
  busy: boolean;
  heldReady: boolean;
  boxes: { elementID: string; presence: number }[];
  boxesSource: string | null;
  playing: boolean;
  inputs: number;
  lastFirstFrame: boolean;
  guesses: { elementID: string; status: string; slot: number | null }[];
  error: string | null;
}

async function snapshot(page: Page): Promise<Snapshot | null> {
  return page.evaluate(() => {
    const controller = window.vibeUI;
    if (controller === undefined) return null;
    const state = controller.store.getState();
    return {
      phase: state.phase,
      sessionStatus: state.sessionStatus,
      busy: state.busy,
      heldReady: state.heldReady,
      boxes: state.boxes.map((box) => ({ elementID: box.elementID, presence: box.presence })),
      boxesSource: state.boxesSource,
      playing: state.playing,
      inputs: state.inputs.length,
      lastFirstFrame: (state.inputs.at(-1)?.firstFrameAt ?? null) !== null,
      guesses: state.guesses.map((guess) => ({
        elementID: guess.elementID,
        status: guess.status,
        slot: guess.slot,
      })),
      error: state.error,
    };
  });
}

async function waitFor(
  page: Page,
  label: string,
  predicate: (state: Snapshot) => boolean,
  timeoutMs: number,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await snapshot(page);
    if (state !== null && predicate(state)) return state;
    if (state?.phase === "ended")
      throw new Error(`session ended while waiting for ${label}: ${state.error ?? ""}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

let browser: Browser | null = null;
let runID: string | null = null;
const poolIndex = process.argv.indexOf("--pool");
const pool = poolIndex === -1 ? null : process.argv[poolIndex + 1];
const instructIndex = process.argv.indexOf("--instruct");
const instructions =
  instructIndex === -1 ? [] : (process.argv[instructIndex + 1] ?? "").split("|").filter(Boolean);
const omniIndex = process.argv.indexOf("--omni");
const omni = omniIndex === -1 ? null : process.argv[omniIndex + 1];
const hardTimeoutMs = (mode === "loop" ? loopSeconds * 1000 : 0) + 150_000;

let page: Page | null = null;
let ended = false;

async function endSession(reason: string): Promise<void> {
  if (ended || page === null) return;
  ended = true;
  const current = page;
  await current
    .evaluate(async (why) => {
      await window.vibeUI?.end(why);
    }, reason)
    .catch(() => undefined);
  await sleep(800);
  log(`session ended (${reason})`);
}

async function shot(name: string): Promise<void> {
  if (page === null) return;
  const path = join(proofDirectory, `${name}.png`);
  await page.screenshot({ path });
  log(`screenshot ${path}`);
}

async function saveFrame(name: string): Promise<void> {
  if (page === null) return;
  const frame = await page.evaluate(() => window.vibeUI?.lastFrame ?? null);
  if (frame === null) return;
  writeFileSync(join(proofDirectory, `${name}.jpg`), Buffer.from(frame.base64, "base64"));
  writeFileSync(join(proofDirectory, `${name}.json`), JSON.stringify(frame.boxes, null, 2));
}

type Plan = "hit" | "miss" | "mid-clip";
const pattern: Plan[] = ["hit", "miss", "hit", "mid-clip"];

const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const Center = z.object({ x: z.number(), y: z.number() }).nullable();

/**
 * Presses an element with the real mouse at its box center on the video, the way a person does,
 * then presses again at once (refused while its answer is pending) and in the top left corner of
 * the video (a press on no box), so the run log shows every kind of press.
 */
async function clickElement(current: Page, elementID: string): Promise<void> {
  const rect = Rect.nullable().parse(
    await current.evaluate(() => {
      const box = window.vibeUI?.video?.getBoundingClientRect();
      return box === undefined
        ? null
        : { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  const center = Center.parse(
    await current.evaluate((id) => {
      const found = window.vibeUI?.store.getState().boxes.find((box) => box.elementID === id);
      return found === undefined
        ? null
        : { x: (found.box.left + found.box.right) / 2, y: (found.box.top + found.box.bottom) / 2 };
    }, elementID),
  );
  if (rect === null || center === null) {
    log(`no box for ${elementID}; clicking by id`);
    await current.evaluate((id) => {
      window.vibeUI?.input({ kind: "click", elementID: id });
    }, elementID);
    return;
  }
  const x = rect.x + center.x * rect.width;
  const y = rect.y + center.y * rect.height;
  await current.mouse.click(x, y);
  await current.mouse.click(x, y);
  await current.mouse.click(rect.x + 4, rect.y + 4);
}

let hits = 0;

async function choose(current: Page, plan: Plan): Promise<string | null> {
  if (plan !== "miss") hits++;
  const preferHelper = hits % 2 === 0;
  const deadline = Date.now() + (plan === "hit" ? 20_000 : 3_000);
  for (;;) {
    const state = await snapshot(current);
    if (state === null) return null;
    const boxed = state.boxes.filter((box) => box.presence >= 0.5).map((box) => box.elementID);
    const live = state.guesses.filter(
      (guess) => guess.status !== "popped" && guess.status !== "failed",
    );
    const built = live
      .filter((guess) => guess.status === "built")
      .sort((first, second) =>
        preferHelper
          ? (second.slot ?? 0) - (first.slot ?? 0)
          : (first.slot ?? 0) - (second.slot ?? 0),
      )
      .map((guess) => guess.elementID);
    const guessed = new Set(live.map((guess) => guess.elementID));
    if (plan === "miss") {
      const unguessed = boxed.filter((elementID) => !guessed.has(elementID));
      if (unguessed.length > 0) return unguessed[0] ?? null;
    } else {
      const ready = built.find((elementID) => boxed.includes(elementID)) ?? built[0];
      if (ready !== undefined) return ready;
    }
    if (Date.now() > deadline) return boxed[0] ?? null;
    await sleep(250);
  }
}

async function runLoop(current: Page): Promise<void> {
  await waitFor(current, "opening clip ready for input", (state) => state.heldReady, 60_000);
  await shot("00-opening-held");
  for (const [index, text] of instructions.entries()) {
    log(`instruct ${index + 1}: ${text}`);
    await current.evaluate((message) => {
      window.vibeUI?.input({ kind: "instruct", text: message });
    }, text);
    await waitFor(current, "first frame", (state) => state.lastFirstFrame, 45_000);
    await waitFor(current, "held after instruction", (state) => state.heldReady, 45_000);
    await sleep(3000);
    await shot(`i${index + 1}-held`);
  }
  const deadline = Date.now() + loopSeconds * 1000;
  let clicks = 0;
  while (Date.now() < deadline) {
    const plan = pattern[clicks % pattern.length] ?? "hit";
    if (plan === "mid-clip") {
      await waitFor(current, "a clip playing", (state) => state.playing, 45_000);
      await sleep(2000);
    } else {
      await waitFor(current, "held frame ready", (state) => state.heldReady, 45_000);
      await sleep(1000);
    }
    const target = await choose(current, plan);
    if (target === null) {
      log("nothing to click; stopping");
      break;
    }
    clicks++;
    log(`click ${clicks} (${plan}): ${target}`);
    await clickElement(current, target);
    const name = `${String(clicks).padStart(2, "0")}-${plan}-${target}`;
    await waitFor(current, "first frame", (state) => state.lastFirstFrame, 45_000);
    if (pattern[clicks % pattern.length] === "mid-clip") continue;
    await sleep(1500);
    await shot(`${name}-playing`);
    if (plan !== "hit") continue;
    await waitFor(current, "held after hit", (state) => state.heldReady, 45_000).catch(() => null);
    await shot(`${name}-held`);
    await saveFrame(`${name}-held-frame`);
  }
  await shot("99-final");
  log(`clicks: ${clicks}`);
}

const finish = registerCleanup({
  end: async (reason) => {
    await endSession(reason);
    await browser?.close().catch(() => undefined);
    await sleep(500);
    for (const line of await closeRunSessions(runID)) log(line);
    log(`proof in ${proofDirectory}`);
  },
  timeoutMs: hardTimeoutMs,
  log,
});

async function main(): Promise<void> {
  const server = await startDevServer({ port });
  log(`dev server up on ${port}`);
  browser = await launchBrowser({ headed });
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  page = await context.newPage();
  const current = page;
  current.on("pageerror", (error) => {
    log(`page error: ${error.message}`);
  });
  await current.goto(
    `${server.url}/?autostart${pool === null ? "" : `&pool=${pool}`}${omni === null ? "" : `&omni=${omni}`}`,
  );
  runID = await current.evaluate(() => window.vibeUI?.summary().runID ?? null);
  const started = Date.now();
  await waitFor(current, "session ready", (state) => state.sessionStatus === "ready", 30_000);
  log(`session ready after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (mode === "ready") {
    await sleep(500);
    await shot("session-ready");
  } else if (mode === "probe") {
    await waitFor(current, "clip playing", (state) => state.playing, 45_000);
    await waitFor(
      current,
      "boxes while playing",
      (state) => state.boxesSource === "playing",
      30_000,
    ).catch(() => null);
    await shot("playing-with-boxes");
    await waitFor(current, "boxes on held frame", (state) => state.heldReady, 30_000);
    await sleep(500);
    await shot("held-with-boxes");
    await saveFrame("held-frame");
  } else await runLoop(current);
  const summary = await current.evaluate(() => window.vibeUI?.summary());
  await endSession("driver_done");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const failed = summary?.inputs.filter((input) => input.failed !== null).length ?? 0;
  if (failed > 0) {
    log(`${failed} inputs failed`);
    process.exitCode = 3;
  }
}

main()
  .then(() => finish("driver_exit"))
  .catch(async (error: unknown) => {
    log(`failed: ${String(error)}`);
    await finish("driver_error");
    process.exit(1);
  });
