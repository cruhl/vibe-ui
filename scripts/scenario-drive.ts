import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { z } from "zod";
import {
  closeRunSessions,
  createLog,
  keysFromEnvironment,
  launchBrowser,
  registerCleanup,
  root,
  seedKeys,
  sleep,
  startDevServer,
} from "./plumbing.ts";

const usage = `pnpm scenario-drive (--preset <id> | --idea "<idea>") [--step <step>]... [options]

Proves one world end to end on real Omni and Jev sessions with the keys in .env.local. Starts its
own dev server with a fresh dependency cache, opens the world in headless Chromium (a scenario
folder by id, or an idea typed into the picker and written live), waits for the opening's first
frame, then runs each step on the held frame and waits for its answer's first frame and held frame.

Steps (default: pick:miss pick:hit); every pick chooses among boxed things that take a click,
never a typed-text field:
  pick:<id>   choose that thing once Jev has boxed it
  pick:miss   choose a boxed thing nobody guessed
  pick:hit    choose a boxed thing whose guessed moment is built or later (else any guess)
  pick:baked  choose a boxed thing whose moment came from the saved tree and is ready
  pick:top    choose the boxed guess the engine ranks likeliest, whatever its status
  pick:random choose any boxed thing at random (seeded by --seed, default 1), guessed or not
  pick:any    choose the first boxed thing not chosen before
  pick:rapid  choose like pick:miss, then while the input is locked click the same thing again
              and then another boxed thing, which the app keeps and replays when the lock lifts
  point:<x>,<y> click that point of the picture, in fractions of its width and height, boxed
              or not; a click on no box is read by Jev and answered by the agent
  point:open  click the point of the picture farthest from every box
  tell:<text> give the world a direct message
  pause:<s>   once the frame is held, pause the session for that many seconds, then resume
  end         press End and its confirm as a person does and wait for the picker the page
              reloads into; the last step, reporting seconds from confirm to picker

Options:
  --port <n>        dev server port (default 5401)
  --out <name>      proof folder name (default: the world and the time)
  --pick            open the home picker and choose the preset there, as a person does, and
                    report seconds from that choice to the opening's first frame
  --dwell <seconds> pace picks like a person: wait for the held frame and until that long since
                    the previous click, then take what is there
  --query <params>  more URL parameters for the page, such as "warmPause=5&guesses=5"
  --seed <n>        seed for pick:random (default 1), so a random path repeats
  --reopen          with --idea: end the session, open the written world's link again in the
                    same browser, report its opening from the moments this browser saved, and
                    export its folder as export.zip

Before every pick the target is ringed on a screenshot; the press lands at the point of its box
nearest the center that lies outside every other box. Writes the frames (opening, each target,
the whole page at a few marks while each answer is coming, with what covers the picture logged,
each answer while it moves and once held), log.txt and result.json with click to first frame per
step to .agent/proof/<out>/, and ends with one line per click saying where its answer played
from: baked (local media from the saved tree), captured-live (local media this session captured
before the click), live hit (a guess played from its session) or miss (the agent answered after
the click). Ends the session, closes every Reactor session through the API as a
backstop, and stops the server and the browser on every exit path. Exits 1 when any step fails,
2 on the hard timeout.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.length === 0) {
  process.stdout.write(`${usage}\n`);
  process.exit(argv.length === 0 ? 1 : 0);
}
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const preset = option("preset");
const idea = option("idea");
if ((preset === null) === (idea === null)) {
  process.stdout.write(`${usage}\n`);
  process.exit(1);
}
const steps = argv.flatMap((arg, index) =>
  arg === "--step" && argv[index + 1] !== undefined ? [argv[index + 1] ?? ""] : [],
);
const plan = steps.length === 0 ? ["pick:miss", "pick:hit"] : steps;
const port = Number(option("port") ?? 5401);
const query = option("query");
const queryTail = query === null || query === "" ? "" : `&${query}`;
const dwell = option("dwell") === null ? null : Number(option("dwell"));
let lastClickAt = 0;
let seed = Number(option("seed") ?? 1);
/** A small seeded generator (mulberry32), so a random path repeats with its seed. */
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const name =
  option("out") ?? `${preset ?? "idea"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const proofDirectory = join(root, ".agent", "proof", name);
mkdirSync(proofDirectory, { recursive: true });
const log = createLog(join(proofDirectory, "log.txt"));

const Box = z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() });

const Snapshot = z.object({
  phase: z.string(),
  heldReady: z.boolean(),
  locked: z.string().nullable(),
  inputs: z.array(
    z.object({
      inputID: z.string(),
      t: z.number(),
      label: z.string(),
      outcome: z.string(),
      firstFrameAt: z.number().nullable(),
      boxesAt: z.number().nullable(),
      source: z.string().nullable(),
      failed: z.string().nullable(),
    }),
  ),
  boxes: z.array(z.object({ elementID: z.string(), presence: z.number(), box: Box })),
  elements: z.array(z.object({ id: z.string(), look: z.string(), kind: z.string() })),
  guesses: z.array(
    z.object({
      elementID: z.string(),
      status: z.string(),
      baked: z.boolean(),
      likelihood: z.number().nullable(),
    }),
  ),
  video: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable(),
  runID: z.string().nullable(),
  preset: z.string(),
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
        inputID: input.inputID,
        t: input.t,
        label: input.label,
        outcome: input.outcome,
        firstFrameAt: input.firstFrameAt,
        boxesAt: input.boxesAt,
        source: input.source,
        failed: input.failed,
      })),
      boxes: state.boxes.map((box) => ({
        elementID: box.elementID,
        presence: box.presence,
        box: box.box,
      })),
      elements: state.shownView.elements.map((element) => ({
        id: element.id,
        look: element.look,
        kind: element.kind,
      })),
      guesses: state.guesses.map((guess) => ({
        elementID: guess.elementID,
        status: guess.status,
        baked: guess.baked,
        likelihood: guess.likelihood,
      })),
      video:
        rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      runID: controller.summary().runID,
      preset: state.scenario.id,
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
    if (state?.phase === "ended") throw new Error(`session ended waiting for ${label}`);
    const written = await page
      .locator('[data-testid="scenario-error"]')
      .textContent({ timeout: 50 })
      .catch(() => null);
    if (written !== null && written.trim() !== "") throw new Error(`scenario error: ${written}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

const Event = z.looseObject({ kind: z.string(), t: z.number() });
type Event = z.infer<typeof Event>;

function events(runID: string | null): Event[] {
  if (runID === null) return [];
  const path = join(root, ".agent", "runs", `${runID}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Event.parse(JSON.parse(line)));
}

/** Waits until the run log on disk holds an event of `kind`, then returns the whole log. */
async function eventsWith(runID: string | null, kind: string, timeoutMs = 5000): Promise<Event[]> {
  const deadline = Date.now() + timeoutMs;
  let all = events(runID);
  while (!all.some((event) => event.kind === kind) && Date.now() < deadline) {
    await sleep(250);
    all = events(runID);
  }
  return all;
}

/** Runs the Reactor backstop on a run's sessions once its last log lines have reached disk. */
async function closeSessions(runID: string | null): Promise<string[]> {
  await sleep(800);
  return closeRunSessions(runID);
}

/**
 * Screenshots the video on screen, with the target ringed in red when given, or every current box
 * outlined in yellow with its id when `allBoxes` is set.
 */
async function frame(
  page: Page,
  file: string,
  mark: z.infer<typeof Box> | null = null,
  allBoxes = false,
) {
  const state = await snapshot(page);
  if (state?.video == null) return;
  const video = state.video;
  const rings = [
    ...(mark === null ? [] : [{ box: mark, color: "#ff2d55", label: "" }]),
    ...(allBoxes
      ? state.boxes.map((found) => ({ box: found.box, color: "#ffd60a", label: found.elementID }))
      : []),
  ].map((ring) => ({
    left: video.x + ring.box.left * video.width,
    top: video.y + ring.box.top * video.height,
    width: (ring.box.right - ring.box.left) * video.width,
    height: (ring.box.bottom - ring.box.top) * video.height,
    color: ring.color,
    label: ring.label,
  }));
  if (rings.length > 0)
    await page.evaluate((items) => {
      for (const item of items) {
        const ring = document.createElement("div");
        ring.className = "proof-mark";
        ring.textContent = item.label;
        Object.assign(ring.style, {
          position: "fixed",
          left: `${String(item.left)}px`,
          top: `${String(item.top)}px`,
          width: `${String(item.width)}px`,
          height: `${String(item.height)}px`,
          border: `3px solid ${item.color}`,
          borderRadius: "6px",
          color: item.color,
          font: "bold 12px sans-serif",
          textShadow: "0 0 3px #000",
          zIndex: "99999",
          pointerEvents: "none",
        });
        document.body.append(ring);
      }
    }, rings);
  await page.screenshot({
    path: join(proofDirectory, file),
    clip: { x: video.x, y: video.y, width: video.width, height: video.height },
  });
  if (rings.length > 0)
    await page.evaluate(() => {
      for (const ring of document.querySelectorAll(".proof-mark")) ring.remove();
    });
  log(`frame ${file}`);
}

const waitingMarks = [1.2, 3, 5.5, 9];

const Stage = z.object({ overlays: z.array(z.string()), busy: z.string().nullable() });

/**
 * While an answer is coming, screenshots the whole page at a few marks after the click and logs
 * what covers the picture: every element painted over at least half the video, and the busy text.
 */
async function waitingFrames(page: Page, prefix: string, inputsBefore: number): Promise<void> {
  const clickedAt = Date.now();
  for (const [index, mark] of waitingMarks.entries()) {
    const wait = clickedAt + mark * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    const state = await snapshot(page).catch(() => null);
    const latest = state?.inputs.at(-1);
    if (state === null || latest === undefined || state.inputs.length <= inputsBefore) continue;
    if (latest.firstFrameAt !== null || latest.failed !== null) return;
    const raw: unknown = await page.evaluate(() => {
      const video = window.vibeUI?.video?.getBoundingClientRect();
      const area = video === undefined ? 0 : video.width * video.height;
      const overlays = [...document.querySelectorAll(".stage *")]
        .filter((node) => node.tagName !== "VIDEO" && node.tagName !== "CANVAS")
        .filter((node) => {
          const style = getComputedStyle(node);
          if (style.visibility === "hidden" || Number(style.opacity) < 0.05) return false;
          if (node.tagName !== "IMG" && style.backgroundImage === "none") return false;
          const rect = node.getBoundingClientRect();
          return area > 0 && rect.width * rect.height >= area / 2;
        })
        .map((node) => `${node.tagName.toLowerCase()}.${node.className}`);
      const busy = document.querySelector('[data-testid="busy-state"]');
      return { overlays, busy: busy instanceof HTMLElement ? busy.innerText : null };
    });
    const stage = Stage.parse(raw);
    const file = `${prefix}w${String(index + 1)}-waiting.png`;
    await page.screenshot({ path: join(proofDirectory, file) });
    log(
      `${prefix}: waiting ${String(mark)} s, ${file}, over the picture: ${stage.overlays.join(", ") || "nothing"}; busy: ${JSON.stringify(stage.busy)}`,
    );
  }
}

interface StepResult {
  step: string;
  target: string | null;
  look: string | null;
  outcome: string | null;
  /** Where the answer played from: local media (captured or baked), or live from a session. */
  source: string | null;
  /** The target's moment status when it was clicked. */
  guessStatus: string | null;
  /** Whether the target's moment came from the saved tree, filmed there or written only. */
  guessBaked: boolean;
  /** Where the answer played from: baked, captured-live, live hit or miss. */
  played: string | null;
  secondsToFirstFrame: number | null;
  secondsToBoxes: number | null;
  /** Thumbnail difference between the frame before the click and the answer's first frame. */
  seam: number | null;
  /** Jev requests about the screen itself between the click and the held frame. */
  screenJevRequests: number | null;
  /** For a point step on no box: what Jev saw there, how sure, and how long it took. */
  pointSeen: { thingID: string | null; probability: number; latencyMs: number } | null;
  /** For a point step: the things that take a click after the answer that were not there before. */
  added: string[] | null;
  failed: string | null;
}

const builtOrLater = (status: string) => ["built", "captured", "ready"].includes(status);

const held = (state: Snapshot) =>
  state.heldReady && state.boxes.length > 0 && state.locked === null;

async function chooseTarget(
  page: Page,
  step: string,
  chosen: Set<string>,
): Promise<{ state: Snapshot; target: string }> {
  const kind = step.slice("pick:".length);
  if (!["miss", "hit", "any", "rapid", "baked", "top", "random"].includes(kind)) {
    const state = await waitFor(
      page,
      `a box for ${kind}`,
      (current) =>
        held(current) && current.boxes.some((box) => box.elementID === kind && box.presence >= 0.5),
      60_000,
    );
    return { state, target: kind };
  }
  let state = await waitFor(page, "a held frame with boxes", held, 90_000);
  if (dwell !== null) {
    const wait = lastClickAt + dwell * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    state = (await snapshot(page)) ?? state;
  } else if (kind === "hit") {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !state.guesses.some((guess) => guess.status === "ready")) {
      await sleep(500);
      state = (await snapshot(page)) ?? state;
    }
  }
  if (dwell === null) await sleep(500);
  state = (await snapshot(page)) ?? state;
  const typed = new Set(
    state.elements.filter((element) => element.kind === "input").map((element) => element.id),
  );
  const boxed = state.boxes
    .filter((box) => box.presence >= 0.5 && !typed.has(box.elementID))
    .map((box) => box.elementID);
  const guessed = state.guesses.map((guess) => guess.elementID);
  const rank = (status: string) => ["ready", "captured", "built"].indexOf(status);
  const built = state.guesses
    .filter((guess) => builtOrLater(guess.status))
    .sort((first, second) => rank(first.status) - rank(second.status))
    .map((guess) => guess.elementID);
  const fresh = (id: string) => !chosen.has(id);
  const baked = state.guesses
    .filter((guess) => guess.baked && guess.status === "ready")
    .map((guess) => guess.elementID);
  if (kind === "top") {
    const top = [...state.guesses]
      .filter((guess) => boxed.includes(guess.elementID))
      .sort((first, second) => (second.likelihood ?? -1) - (first.likelihood ?? -1))[0];
    if (top !== undefined) return { state, target: top.elementID };
  }
  if (kind === "random") {
    const pickedAt = boxed[Math.floor(random() * boxed.length)];
    if (pickedAt !== undefined) return { state, target: pickedAt };
  }
  if (kind === "baked") {
    const found = baked.find((id) => boxed.includes(id));
    if (found === undefined) throw new Error(`no baked guess is boxed: ${baked.join(", ")}`);
    return { state, target: found };
  }
  const target =
    kind === "miss" || kind === "rapid"
      ? (boxed.find((id) => !guessed.includes(id) && fresh(id)) ??
        boxed.find((id) => !guessed.includes(id)))
      : kind === "hit"
        ? (built.find((id) => boxed.includes(id)) ?? guessed.find((id) => boxed.includes(id)))
        : boxed.find(fresh);
  const fallback = target ?? boxed.find(fresh) ?? boxed[0];
  if (fallback === undefined) throw new Error("nothing boxed to choose");
  return { state, target: fallback };
}

/** The point of a box nearest its center that lies outside every other box, or its center. */
function openPoint(
  target: z.infer<typeof Box>,
  others: z.infer<typeof Box>[],
): { x: number; y: number } {
  const center = { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 };
  const steps = Array.from({ length: 11 }, (_, i) => 0.05 + i * 0.09);
  const open = steps
    .flatMap((across) =>
      steps.map((down) => ({
        x: target.left + across * (target.right - target.left),
        y: target.top + down * (target.bottom - target.top),
      })),
    )
    .filter(
      (point) =>
        !others.some(
          (box) =>
            point.x >= box.left &&
            point.x <= box.right &&
            point.y >= box.top &&
            point.y <= box.bottom,
        ),
    )
    .sort(
      (first, second) =>
        Math.hypot(first.x - center.x, first.y - center.y) -
        Math.hypot(second.x - center.x, second.y - center.y),
    );
  return open[0] ?? center;
}

/** Ends the session through the control bar: End, then its confirm, then the picker. */
async function endByHand(page: Page, prefix: string, result: StepResult): Promise<StepResult> {
  result.target = "end";
  await waitFor(page, "a held frame", held, 90_000);
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(size.width / 2, size.height / 3, { steps: 8 });
  await page.getByRole("button", { name: "Shut down", exact: true }).click();
  await sleep(300);
  await page.screenshot({ path: join(proofDirectory, `${prefix}a-end-armed.png`) });
  const confirmedAt = Date.now();
  await page.getByRole("button", { name: "Confirm end", exact: true }).click();
  log(`${prefix}: end confirmed`);
  await sleep(400);
  await page
    .screenshot({ path: join(proofDirectory, `${prefix}b-ending.png`), timeout: 2000 })
    .catch(() => undefined);
  const picker = await page
    .locator('[data-testid="scenario-picker"]')
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!picker) {
    result.failed = "the picker never opened after End";
    return result;
  }
  result.secondsToFirstFrame = Math.round((Date.now() - confirmedAt) / 10) / 100;
  log(`${prefix}: picker ${String(result.secondsToFirstFrame)} s after the confirm`);
  await sleep(1000);
  await page.screenshot({ path: join(proofDirectory, `${prefix}c-ended.png`) });
  return result;
}

async function runStep(
  page: Page,
  step: string,
  index: number,
  chosen: Set<string>,
): Promise<StepResult> {
  const result: StepResult = {
    step,
    target: null,
    look: null,
    outcome: null,
    source: null,
    guessStatus: null,
    guessBaked: false,
    played: null,
    secondsToFirstFrame: null,
    secondsToBoxes: null,
    seam: null,
    screenJevRequests: null,
    pointSeen: null,
    added: null,
    failed: null,
  };
  const prefix = String(index + 1);
  if (step === "end") return endByHand(page, prefix, result);
  if (step.startsWith("pause:")) {
    const seconds = Number(step.slice("pause:".length));
    await waitFor(page, "a held frame", held, 90_000);
    result.target = `pause ${String(seconds)} s`;
    await page.evaluate(() => {
      window.vibeUI?.pause();
    });
    log(`${prefix}: paused for ${String(seconds)} s`);
    await sleep(seconds * 1000);
    await page.evaluate(() => {
      window.vibeUI?.resume();
    });
    log(`${prefix}: resumed`);
    return result;
  }
  let before: Snapshot;
  if (step.startsWith("tell:")) {
    before = await waitFor(page, "a held frame", held, 90_000);
    const text = step.slice("tell:".length);
    result.target = `tell: ${text}`;
    log(`${prefix}: tell ${text}`);
    await frame(page, `${prefix}a-before.png`);
    await page.evaluate((message) => {
      window.vibeUI?.input({ kind: "instruct", text: message });
    }, text);
  } else if (step.startsWith("pick:")) {
    const { state, target } = await chooseTarget(page, step, chosen);
    before = state;
    chosen.add(target);
    const found = state.boxes.find((box) => box.elementID === target);
    if (found === undefined || state.video === null) throw new Error(`no box for ${target}`);
    result.target = target;
    result.look = state.elements.find((element) => element.id === target)?.look ?? null;
    const guessed =
      state.guesses.find((guess) => guess.elementID === target)?.status ?? "unguessed";
    result.guessStatus = guessed;
    result.guessBaked = state.guesses.find((guess) => guess.elementID === target)?.baked ?? false;
    log(
      `${prefix}: pick ${target} (${guessed}) at ${JSON.stringify(found.box)}: ${result.look ?? ""}`,
    );
    await frame(page, `${prefix}a-target-${target}.png`, found.box);
    const point = openPoint(
      found.box,
      state.boxes.filter((box) => box.elementID !== target).map((box) => box.box),
    );
    const video = state.video;
    const press = (at: { x: number; y: number }) =>
      page.mouse.click(video.x + at.x * video.width, video.y + at.y * video.height);
    lastClickAt = Date.now();
    await press(point);
    if (step === "pick:rapid") {
      const other = state.boxes.find(
        (box) => box.elementID !== target && box.presence >= 0.5 && !chosen.has(box.elementID),
      );
      const extras = [
        { id: target, box: found.box },
        ...(other === undefined ? [] : [{ id: other.elementID, box: other.box }]),
      ];
      for (const extra of extras) {
        await sleep(500);
        const locked = (await snapshot(page))?.locked ?? null;
        await press(
          openPoint(
            extra.box,
            state.boxes.filter((box) => box.elementID !== extra.id).map((box) => box.box),
          ),
        );
        log(`${prefix}: extra click on ${extra.id} while ${locked === null ? "open" : "locked"}`);
      }
    }
  } else if (step.startsWith("point:")) {
    await waitFor(page, "a held frame with boxes", held, 90_000);
    await sleep(500);
    before = await waitFor(page, "a held frame with boxes", held, 30_000);
    const spec = step.slice("point:".length);
    const shown = before.boxes.filter((box) => box.presence >= 0.5);
    const point = spec === "open" ? farthestPoint(shown.map((box) => box.box)) : parsePoint(spec);
    if (before.video === null) throw new Error("no video on screen");
    const inside = shown.find(
      (box) =>
        point.x >= box.box.left &&
        point.x <= box.box.right &&
        point.y >= box.box.top &&
        point.y <= box.box.bottom,
    );
    result.target = `point ${point.x.toFixed(2)},${point.y.toFixed(2)}${inside === undefined ? "" : ` in ${inside.elementID}`}`;
    log(`${prefix}: ${result.target}`);
    const ring = 0.02;
    await frame(page, `${prefix}a-point.png`, {
      left: point.x - ring,
      right: point.x + ring,
      top: point.y - ring * 1.8,
      bottom: point.y + ring * 1.8,
    });
    const video = before.video;
    lastClickAt = Date.now();
    await page.mouse.click(video.x + point.x * video.width, video.y + point.y * video.height);
  } else throw new Error(`unknown step ${step}`);
  const [answered] = await Promise.all([
    waitFor(
      page,
      "the answer's first frame",
      (current) =>
        current.inputs.length > before.inputs.length &&
        (current.inputs.at(-1)?.firstFrameAt != null || current.inputs.at(-1)?.failed != null),
      90_000,
    ),
    waitingFrames(page, prefix, before.inputs.length),
  ]);
  const input = answered.inputs.at(-1);
  result.outcome = input?.outcome ?? null;
  result.failed = input?.failed ?? null;
  if (input?.firstFrameAt != null)
    result.secondsToFirstFrame = Math.round((input.firstFrameAt - input.t) * 100) / 100;
  log(
    `${prefix}: ${result.outcome ?? "?"} first frame ${result.secondsToFirstFrame ?? "?"} s${result.failed === null ? "" : `, failed ${result.failed}`}`,
  );
  if (result.failed !== null) return result;
  await sleep(1500);
  await frame(page, `${prefix}b-moving.png`);
  const settled = await waitFor(page, "the answer held", held, 60_000).catch((error: unknown) => {
    log(`${prefix}: ${String(error)}`);
    return null;
  });
  const last = settled?.inputs.find((item) => item.inputID === input?.inputID) ?? null;
  result.source = last?.source ?? null;
  const hitClip = events(settled?.runID ?? null).find(
    (event) => event.kind === "speculation_hit" && event.inputID === input?.inputID,
  )?.clipID;
  result.played =
    result.outcome === "miss"
      ? "miss"
      : result.source === "local"
        ? typeof hitClip === "string" && hitClip.startsWith("baked-")
          ? "baked"
          : "captured-live"
        : result.source === "live"
          ? "live hit"
          : null;
  if (last?.boxesAt != null)
    result.secondsToBoxes = Math.round((last.boxesAt - last.t) * 100) / 100;
  if (last !== null) {
    const seam = events(settled?.runID ?? null).find(
      (event) => event.kind === "first_frame" && event.t >= last.t,
    )?.seam;
    result.seam = typeof seam === "number" ? seam : null;
    const heldAt = events(settled?.runID ?? null)
      .filter((event) => event.kind === "ready_for_input" && event.t >= last.t)
      .map((event) => event.t)[0];
    result.screenJevRequests = events(settled?.runID ?? null).filter(
      (event) =>
        event.kind === "boxes_requested" &&
        event.source !== "capture" &&
        event.t >= last.t &&
        (heldAt === undefined || event.t <= heldAt),
    ).length;
  }
  log(
    `${prefix}: from ${result.source ?? "?"}, seam ${result.seam ?? "?"}, boxes ${result.secondsToBoxes ?? "?"} s after the click, ${result.screenJevRequests ?? "?"} Jev requests about the screen`,
  );
  await frame(page, `${prefix}c-held.png`, null, true);
  if (step.startsWith("point:") && input !== undefined) {
    const all = events(settled?.runID ?? null);
    const seen = all.find(
      (event) => event.kind === "point_seen" && event.inputID === input.inputID,
    );
    if (seen !== undefined)
      result.pointSeen = {
        thingID: typeof seen.thingID === "string" ? seen.thingID : null,
        probability: typeof seen.probability === "number" ? seen.probability : 0,
        latencyMs: typeof seen.latencyMs === "number" ? seen.latencyMs : 0,
      };
    const known = new Set(before.elements.map((element) => element.id));
    result.added = (settled?.elements ?? [])
      .filter((element) => !known.has(element.id))
      .map((element) => `${element.id}: ${element.look}`);
    const beat = all.find((event) => event.kind === "beat" && event.inputID === input.inputID);
    log(
      `${prefix}: Jev saw ${result.pointSeen === null ? "nothing asked (a box was hit)" : `${result.pointSeen.thingID ?? "open background"} (${String(result.pointSeen.probability)}) in ${String(result.pointSeen.latencyMs)} ms`}; answered ${input.label}; beat ${typeof beat?.text === "string" ? beat.text : "?"}; new picks ${result.added.join("; ") || "none"}`,
    );
  }
  return result;
}

function parsePoint(spec: string): { x: number; y: number } {
  const [x, y] = spec.split(",").map(Number);
  if (x === undefined || y === undefined || !(x >= 0 && x <= 1 && y >= 0 && y <= 1))
    throw new Error(`point:${spec} needs two fractions of the picture, such as point:0.6,0.5`);
  return { x, y };
}

/** The point of a grid over the picture farthest from every box, away from its very edges. */
function farthestPoint(boxes: z.infer<typeof Box>[]): { x: number; y: number } {
  const distance = (point: { x: number; y: number }, box: z.infer<typeof Box>) =>
    Math.hypot(
      Math.max(box.left - point.x, 0, point.x - box.right),
      Math.max(box.top - point.y, 0, point.y - box.bottom),
    );
  const steps = Array.from({ length: 9 }, (_, i) => 0.1 + i * 0.1);
  const grid = steps.flatMap((x) => steps.map((y) => ({ x, y })));
  const clearance = (point: { x: number; y: number }) =>
    Math.min(...boxes.map((box) => distance(point, box)), Number.POSITIVE_INFINITY);
  return (
    grid.sort((first, second) => clearance(second) - clearance(first))[0] ?? { x: 0.5, y: 0.5 }
  );
}

let activeRunID: string | null = null;

const cleanup = registerCleanup({
  log,
  timeoutMs: 600_000 + plan.length * 120_000,
  end: async () => {
    if (activeRunID !== null) for (const line of await closeSessions(activeRunID)) log(line);
    activeRunID = null;
  },
});

async function main(): Promise<boolean> {
  const server = await startDevServer({ port, extraArguments: ["--force"] });
  log(`dev server up on ${port}`);
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await seedKeys(context, keysFromEnvironment());
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    log(`page error: ${error.message}`);
  });
  const results: StepResult[] = [];
  const summary: Record<string, unknown> = { preset, idea, plan };
  let ok = true;
  try {
    if (preset !== null && argv.includes("--pick")) {
      await page.goto(`${server.url}/${queryTail === "" ? "" : `?${queryTail.slice(1)}`}`);
      const card = page.locator(`[data-scenario="${preset}"] .picker-open`);
      await card.waitFor({ timeout: 30_000 });
      await sleep(1500);
      await card.click();
      log(`picked ${preset} in the picker`);
    } else if (preset !== null) {
      await page.goto(`${server.url}/?preset=${preset}${queryTail}`);
      await waitFor(page, "the controller", () => true, 30_000);
    } else {
      await page.goto(`${server.url}/`);
      await page.waitForSelector('[data-testid="scenario-idea"]', { timeout: 30_000 });
      await page.fill('[data-testid="scenario-idea"]', idea ?? "");
      await page.click('[data-testid="scenario-write"] button[type="submit"]');
      log(`submitted ${idea ?? ""}`);
    }
    const submittedAt = Date.now();
    const opened = await waitFor(
      page,
      "the opening's first frame",
      (state) => state.inputs[0]?.firstFrameAt != null,
      180_000,
    );
    activeRunID = opened.runID;
    summary.runID = opened.runID;
    summary.world = opened.preset;
    summary.secondsToOpeningFrame = Math.round((Date.now() - submittedAt) / 100) / 10;
    log(`opening first frame on ${opened.preset} after ${String(summary.secondsToOpeningFrame)} s`);
    const opening = await eventsWith(opened.runID, "first_frame");
    const launched = opening.find((event) => event.kind === "scenario_launched")?.t ?? null;
    const first = opening.find((event) => event.kind === "first_frame")?.t ?? null;
    const start = opening.find((event) => event.kind === "input")?.t ?? null;
    summary.secondsFromPickToOpeningFrame =
      launched === null || first === null ? null : Math.round((first - launched) * 1000) / 1000;
    summary.secondsFromStartToOpeningFrame =
      start === null || first === null ? null : Math.round((first - start) * 1000) / 1000;
    const openingSource = opened.inputs[0]?.source ?? null;
    summary.openingSource = openingSource;
    log(
      [
        ...(launched === null
          ? []
          : [`pick to opening first frame ${String(summary.secondsFromPickToOpeningFrame)} s`]),
        `start to first frame ${String(summary.secondsFromStartToOpeningFrame)} s`,
        `from ${openingSource ?? "a live session"}`,
      ].join(", "),
    );
    if (idea !== null) {
      const at = (kind: string) => opening.find((event) => event.kind === kind)?.t ?? null;
      const submitted = at("scenario_idea_submitted");
      const playable = at("scenario_playable");
      summary.secondsToPlayable =
        submitted === null || playable === null
          ? null
          : Math.round((playable - submitted) * 100) / 100;
      summary.repaired = opening.some((event) => event.kind === "scenario_repaired");
    }
    await sleep(1500);
    await frame(page, "0-opening.png");
    const chosen = new Set<string>();
    for (const [index, step] of plan.entries()) {
      const result = await runStep(page, step, index, chosen);
      results.push(result);
      if (result.failed !== null) ok = false;
      writeFileSync(
        join(proofDirectory, "result.json"),
        `${JSON.stringify({ ...summary, steps: results }, null, 2)}\n`,
      );
    }
    const all = events(activeRunID);
    summary.references = all
      .filter((event) => event.kind === "references_chosen")
      .map((event) => event.references);
    summary.picturesCaptured = all
      .filter((event) => event.kind === "asset_added")
      .map((event) => event.label);
    const runStart = all.find((event) => event.kind === "run_start")?.t ?? null;
    summary.secondsToSlotsReady =
      runStart === null
        ? null
        : all
            .filter((event) => event.kind === "slot_ready")
            .map((event) => Math.round((event.t - runStart) * 100) / 100);
    summary.hoverEvents = all.filter((event) => event.kind === "box_hover").length;
    log(
      `sessions ready at ${JSON.stringify(summary.secondsToSlotsReady)} s from the start, ${String(summary.hoverEvents)} hover events`,
    );
    summary.rejectedLines = all
      .filter((event) => event.kind === "line_rejected")
      .map((event) => `${String(event.line)}: ${String(event.error)}`);
  } catch (error: unknown) {
    ok = false;
    summary.error = String(error);
    log(`failed: ${String(error)}`);
    await page.screenshot({ path: join(proofDirectory, "9-failure.png") }).catch(() => undefined);
    activeRunID ??= (await snapshot(page).catch(() => null))?.runID ?? null;
  } finally {
    await page
      .evaluate(async () => {
        await window.vibeUI?.end("scenario_drive_done");
      })
      .catch(() => undefined);
    await sleep(1500);
    summary.sessions = await closeSessions(activeRunID);
    activeRunID = null;
    writeFileSync(
      join(proofDirectory, "result.json"),
      `${JSON.stringify({ ...summary, steps: results }, null, 2)}\n`,
    );
  }
  if (argv.includes("--reopen") && idea !== null && typeof summary.world === "string")
    ok = (await reopen(page, server.url, summary.world, summary)) && ok;
  writeFileSync(
    join(proofDirectory, "result.json"),
    `${JSON.stringify({ ...summary, steps: results }, null, 2)}\n`,
  );
  for (const [index, step] of results.entries())
    log(
      `click ${String(index + 1)} ${step.step} ${step.target ?? "?"}: ${step.played ?? step.outcome ?? "?"}${step.played === "live hit" ? ` (${step.guessStatus ?? "?"})` : ""}, first frame ${String(step.secondsToFirstFrame ?? "?")} s${step.failed === null ? "" : `, failed ${step.failed}`}`,
    );
  log(`proof in ${proofDirectory}`);
  return ok;
}

const Exported = z.object({ base64: z.string().nullable() });

/** Opens a written scenario's link again in the same browser and exports its folder. */
async function reopen(
  page: Page,
  url: string,
  scenarioID: string,
  summary: Record<string, unknown>,
) {
  try {
    await page.goto(`${url}/?preset=${scenarioID}`);
    const opened = await waitFor(
      page,
      "the reopened opening's first frame",
      (state) => state.inputs[0]?.firstFrameAt != null || state.inputs[0]?.failed != null,
      120_000,
    );
    activeRunID = opened.runID;
    const all = await eventsWith(opened.runID, "first_frame");
    const start = all.find((event) => event.kind === "input")?.t ?? null;
    const first = all.find((event) => event.kind === "first_frame")?.t ?? null;
    summary.reopen = {
      runID: opened.runID,
      restored: all.find((event) => event.kind === "moments_restored")?.moments ?? null,
      source: opened.inputs[0]?.source ?? null,
      secondsToOpeningFrame:
        start === null || first === null ? null : Math.round((first - start) * 1000) / 1000,
    };
    log(`reopened: ${JSON.stringify(summary.reopen)}`);
    await sleep(1500);
    await frame(page, "9-reopened.png");
    const exported = Exported.parse(
      await page.evaluate(async () => {
        const blob = (await window.vibeUI?.exportFolder()) ?? null;
        if (blob === null) return { base64: null };
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { base64: btoa(binary) };
      }),
    );
    if (exported.base64 !== null) {
      const path = join(proofDirectory, "export.zip");
      writeFileSync(path, Buffer.from(exported.base64, "base64"));
      const listing = execFileSync("unzip", ["-l", path]).toString();
      writeFileSync(join(proofDirectory, "export.txt"), listing);
      const files = listing
        .split("\n")
        .filter((line) => line.includes(`${scenarioID}/`))
        .map((line) => line.trim().split(/\s+/).slice(-1)[0]);
      summary.exportFiles = files;
      log(`exported ${String(files.length)} files`);
    }
    return true;
  } catch (error: unknown) {
    summary.reopenError = String(error);
    log(`reopen failed: ${String(error)}`);
    return false;
  } finally {
    await page
      .evaluate(async () => {
        await window.vibeUI?.end("scenario_drive_done");
      })
      .catch(() => undefined);
    await sleep(1500);
    summary.reopenSessions = await closeSessions(activeRunID);
    activeRunID = null;
  }
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((error: unknown) => {
    log(`failed: ${String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => cleanup("done"));
