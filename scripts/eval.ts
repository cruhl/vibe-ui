import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { z } from "zod";
import {
  closeSessions,
  createLog,
  launchBrowser,
  portOpen,
  readEnvironment,
  registerCleanup,
  root,
  sleep,
  startDevServer,
} from "./plumbing.ts";
import { buildReport, Prices, summarizeReport } from "../src/eval/report.ts";
import { parseEvalCase } from "../src/eval/case.ts";
import { judgeRun, summarizeJudge } from "./eval-judge.ts";

const usage = `pnpm eval <case> [options]

Runs src/eval/cases/<case>.md in the real app in headless Chromium: starts its own dev
server with hot reload off, opens ?eval=<case>, lets the simulated user drive the session
through window.vibeUI.input, ends the session, and writes .agent/evals/<evalID>/ with
run.jsonl, recording.webm, report.json, summary.txt and, with --judge, judge.json. Kills
everything it started. The same run works in a browser at /?eval=<case> with the same
parameters.

  --omni=mock|real        video model (default mock); real bills a Reactor session
  --jev=mock|real         box finder (default: same as --omni)
  --agent=real|replay     the agent, or recorded replies from src/eval/replays (default real)
  --replay=<fixture>      replay fixture name (default: the case's "replay")
  --user=llm|scripted     simulated user (default: the case's "user")
  --speed=<n>             content clock speed for mock Omni runs (default 1)
  --fault=<list>          mock Omni faults: slow:<n>:<seconds>, black:<n>, refuse:<n>
  --judge                 have Gemini review the recording twice and report the gap
  --headed                show the browser
  --port=<n>              dev server port (default: the first free port from 5320)
  --timeout=<seconds>     hard wall-clock limit (default: case seconds / speed + 180)
  --set=<name>=<value>    pass a URL parameter to the app, repeatable: a mechanics knob such as
                          guesses, depth, write, budget, warmPause or pool
  --label=<name>          appended to the eval folder name, to tell variants apart

The summary line ends with pacing: inputs whose clip was still building when they arrived (behind,
with the wait to its build), and guess clips built but never played.

Exit codes: 0 every check passed, 1 a timing check or the judge failed, 2 hard timeout,
3 harness error.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv[0] === undefined || argv[0].startsWith("--")) {
  process.stdout.write(`${usage}\n`);
  process.exit(argv.includes("--help") ? 0 : 3);
}
const caseName = argv[0];
const option = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (found !== undefined) return found.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};
const pick = <Value extends string>(name: string, values: readonly Value[], fallback: Value) => {
  const value = option(name) ?? fallback;
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`--${name} must be one of ${values.join(", ")}`);
  return match;
};

const omni = pick("omni", ["mock", "real"] as const, "mock");
const jev = pick("jev", ["mock", "real"] as const, omni);
const agent = pick("agent", ["real", "replay"] as const, "real");
const speed = Number(option("speed") ?? "1");
const judge = argv.includes("--judge");
const headed = argv.includes("--headed");
if (!(speed > 0)) throw new Error("--speed must be a positive number");
if (speed !== 1 && omni === "real") throw new Error("--speed applies only to --omni=mock runs");
const evalCase = parseEvalCase(
  caseName,
  readFileSync(join(root, "src", "eval", "cases", `${caseName}.md`), "utf8"),
);
const userMode = option("user") ?? evalCase.user;
const hardTimeoutMs =
  Number(option("timeout") ?? String(evalCase.limits.maxSeconds / speed + 180)) * 1000;
const label = option("label");
if (label !== null && !/^[a-z0-9-]+$/.test(label))
  throw new Error("--label must be lowercase words and dashes");
const settings = argv
  .filter((arg) => arg.startsWith("--set="))
  .map((arg) => {
    const [key = "", ...rest] = arg.slice("--set=".length).split("=");
    if (!/^[A-Za-z]+$/.test(key) || rest.length === 0) throw new Error(`bad ${arg}`);
    return [key, rest.join("=")] as const;
  });
const evalID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${caseName}${label === null ? "" : `-${label}`}`;
const directory = join(root, ".agent", "evals", evalID);
mkdirSync(directory, { recursive: true });
const environment = readEnvironment();
const viewport = { width: 1280, height: 800 };

const log = createLog();

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
const sessionIDs = new Set<string>();

const EvalState = z.object({
  status: z.string(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
});
const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

async function endSession(reason: string): Promise<void> {
  const current = page;
  if (current === null) return;
  await Promise.race([
    current.evaluate(async (why) => {
      await window.vibeUI?.end(why);
    }, reason),
    sleep(5000),
  ]).catch(() => undefined);
}

async function collectSessionIDs(current: Page): Promise<void> {
  const found = await current
    .evaluate(() =>
      (window.vibeUI?.summaryEvents() ?? []).flatMap((event) =>
        event.kind === "omni_session_id" && typeof event.sessionID === "string"
          ? [event.sessionID]
          : [],
      ),
    )
    .catch(() => []);
  for (const sessionID of found) sessionIDs.add(sessionID);
}

const cleanup = registerCleanup({
  end: async (reason) => {
    if (page !== null) await collectSessionIDs(page);
    await endSession(reason);
    const lines = await closeSessions(sessionIDs);
    const closed = lines.length === 0 ? "no real session" : lines.join("\n");
    log(closed);
    writeFileSync(join(directory, "session.txt"), `${closed}\n`);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  },
  timeoutMs: hardTimeoutMs,
  log,
});

async function freePort(): Promise<number> {
  for (let port = 5320; port < 5400; port++) if (!(await portOpen(port))) return port;
  throw new Error("no free port between 5320 and 5399");
}

async function waitForEval(
  current: Page,
  navigations: () => number,
): Promise<z.infer<typeof EvalState>> {
  let lastActions = -1;
  for (;;) {
    if (navigations() > 1) throw new Error("the page under test reloaded mid-run");
    const raw = await current.evaluate(() => {
      const evalState = window.vibeUIEval?.getState();
      return evalState === undefined
        ? null
        : {
            status: evalState.status,
            summary: evalState.summary,
            error: evalState.error,
            actions: evalState.actions.length,
          };
    });
    if (raw !== null) {
      const state = EvalState.parse(raw);
      if (raw.actions !== lastActions) {
        lastActions = raw.actions;
        log(`${raw.actions} actions, ${state.status}`);
      }
      if (state.status === "done" || state.status === "failed") return state;
    }
    await collectSessionIDs(current);
    await sleep(1000);
  }
}

async function main(): Promise<number> {
  const chosenPort = option("port");
  if (chosenPort === null && (await portOpen(5317)))
    log("a dev server is already on 5317; leaving it alone and starting a private one");
  const server = await startDevServer({
    port: chosenPort === null ? await freePort() : Number(chosenPort),
    logFile: join(directory, "server.log"),
  });
  log(`dev server on ${server.port}`);
  browser = await launchBrowser({ headed });
  context = await browser.newContext({
    viewport,
    recordVideo: { dir: join(directory, "video"), size: viewport },
  });
  page = await context.newPage();
  const current = page;
  const pageLog: string[] = [];
  current.on("pageerror", (error) => pageLog.push(`pageerror ${error.message}`));
  let navigations = 0;
  current.on("framenavigated", (frame) => {
    if (frame === current.mainFrame()) navigations++;
  });
  current.on("console", (message) => {
    if (message.type() === "error") pageLog.push(`console ${message.text()}`);
  });
  const params = new URLSearchParams({
    eval: caseName,
    preset: evalCase.preset,
    omni,
    jev,
    agent,
    user: userMode,
    speed: String(speed),
  });
  const replay = option("replay");
  if (replay !== null) params.set("replay", replay);
  const fault = option("fault");
  if (fault !== null) params.set("mockFault", fault);
  for (const [key, value] of settings) params.set(key, value);
  const videoStartWall = Date.now();
  const startedAt = Date.now();
  await current.goto(`${server.url}/?${params.toString()}`);
  log(`running ${caseName}: omni ${omni}, jev ${jev}, agent ${agent}, user ${userMode}, x${speed}`);
  const state = await waitForEval(current, () => navigations);
  const events = await current.evaluate(() => window.vibeUI?.summaryEvents() ?? []);
  const crop = Rect.nullable().parse(
    await current.evaluate(() => {
      const rect = window.vibeUI?.video?.getBoundingClientRect();
      return rect === undefined
        ? null
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  const wallSeconds = (Date.now() - startedAt) / 1000;
  writeFileSync(
    join(directory, "run.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  writeFileSync(join(directory, "page.log"), `${pageLog.join("\n")}\n`);
  if (state.status === "failed") throw new Error(`the in-page eval failed: ${state.error ?? ""}`);
  const prices = Prices.parse(
    JSON.parse(readFileSync(join(root, "src", "eval", "prices.json"), "utf8")),
  );
  const report = buildReport(events, evalCase.deadlines, prices);
  const mode = `omni ${omni}, jev ${jev}, agent ${agent}, user ${userMode}, x${speed}`;
  const summary = summarizeReport(caseName, mode, report);
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (summary !== state.summary) log(`in-page summary differs: ${state.summary ?? "none"}`);
  const video = current.video();
  await cleanup("eval_exit");
  const recording = join(directory, "recording.webm");
  const videoPath = video === null ? null : await video.path();
  if (videoPath !== null) renameSync(videoPath, recording);
  const pacing = report.timing.pacing;
  const knobs = settings.map(([key, value]) => `${key}=${value}`).join(" ");
  let line = `${summary} | pacing behind ${pacing.behind} of ${pacing.inputs} wait p50/max ${pacing.waitP50 ?? "-"}s/${pacing.waitMax ?? "-"}s built unplayed ${pacing.ahead} | knobs ${knobs === "" ? "default" : knobs} | harness wall ${wallSeconds.toFixed(1)}s`;
  let judgeFailed = false;
  if (judge) {
    const apiKey = environment.OPENROUTER_API_KEY;
    if (apiKey === undefined) throw new Error("--judge needs OPENROUTER_API_KEY in .env.local");
    log("judging the recording twice");
    const result = await judgeRun({
      directory,
      persona: evalCase.persona,
      caseName,
      events,
      videoPath: recording,
      videoStartWall,
      crop,
      apiKey,
    });
    judgeFailed = result.verdicts.length === 0;
    line = `${line} | ${summarizeJudge(result)}`;
  }
  writeFileSync(join(directory, "summary.txt"), `${line}\n`);
  for (const check of report.timing.checks.filter((entry) => !entry.ok))
    log(`check failed: ${check.name}: ${check.detail}`);
  process.stdout.write(`${line}\n${directory}\n`);
  return report.ok && !judgeFailed ? 0 : 1;
}

main()
  .then(async (code) => {
    await cleanup("eval_exit");
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    log(`failed: ${String(error)}`);
    await cleanup("harness_error");
    process.exit(3);
  });
