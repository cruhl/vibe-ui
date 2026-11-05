import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import {
  createLog,
  keysFromEnvironment,
  launchBrowser,
  readEnvironment,
  registerCleanup,
  root,
  seedKeys,
  sleep,
  startDevServer,
} from "./plumbing.ts";

const usage = `node --experimental-strip-types scripts/follow-eval.ts [options]

Measures whether worlds follow the person and keep evolving. Runs the real app and the real agent
(OpenAI) on mock Omni and mock Jev in headless Chromium, through the scripted sessions in
src/eval/follow.json for each preset:

  follow   an ordinary pick, then directions that take the world somewhere new (a submarine,
           everyone a cat, a typed action that jumps to the year 3000), each followed by
           ordinary picks
  wander   ten ordinary picks and nothing else
  long     32 turns: a goal stated early (a surprise party for a grandma), then picks and
           directions that refer to it only obliquely

An ordinary pick chooses the boxed pick chosen least often so far this session, the agent's
likeliest guess first among ties. Each turn records what the person did, the agent's change
lines and the video prompt its clip was filmed from. Then an independent judge (a separate OpenAI
model reading src/eval/follow-judge.md) scores every turn 0 to 5: asked (did it do what was
asked, fully), stayed (did it stay in every direction so far rather than drift back to the
premise), fun (coherent and fun), fresh (did the world move on rather than loop), goal (does it
still serve a goal the person stated) and invented (5 when it never made up intent the person did
not state), and each session once for evolving. Also reports, from each run's log, the agent's
context size and timings per call. Prints the means per criterion and writes sessions.json, judge.json and
summary.txt to .agent/evals/follow/<time>-<label>/. Kills the server and browser it started.

  --preset <id>      repeatable (default: the presets in src/eval/follow.json)
  --session <name>   follow, wander or long, repeatable (default follow and wander)
  --concurrency <n>  sessions run at once, as pages of one browser (default 3)
  --port <n>         dev server port (default 5430)
  --delays <x>       scale every mocked wait (default 1)
  --passes <n>       judge passes per session, averaged (default 2)
  --judge-model <m>  judge model (default gpt-6.1-sol)
  --label <name>     appended to the folder name
  --rejudge <dir>    only judge an existing folder's sessions.json again`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
const values = (name: string) =>
  argv.flatMap((arg, index) =>
    arg === `--${name}` && argv[index + 1] !== undefined ? [argv[index + 1] ?? ""] : [],
  );
const single = (name: string) => values(name)[0] ?? null;
const port = Number(single("port") ?? 5430);
const delays = Number(single("delays") ?? 1);
const passes = Number(single("passes") ?? 2);
const judgeModel = single("judge-model") ?? "gpt-6.1-sol";
const label = single("label");
const rejudge = single("rejudge");

const Plan = z.object({
  presets: z.array(z.string()),
  sessions: z.record(z.string(), z.array(z.string())),
});
const plan = Plan.parse(JSON.parse(readFileSync(join(root, "src", "eval", "follow.json"), "utf8")));
type Step = { kind: "pick" } | { kind: "tell"; text: string };
const stepOf = (written: string): Step =>
  written.startsWith("tell ") ? { kind: "tell", text: written.slice(5) } : { kind: "pick" };
const scripts: Record<string, Step[]> = Object.fromEntries(
  Object.entries(plan.sessions).map(([name, steps]) => [name, steps.map(stepOf)]),
);
const presets = values("preset").length > 0 ? values("preset") : plan.presets;
const sessionNames =
  values("session").length > 0
    ? values("session").filter((name) => scripts[name] !== undefined)
    : ["follow", "wander"];
const concurrency = Number(single("concurrency") ?? 3);

const Turn = z.object({
  turn: z.number(),
  did: z.string(),
  outcome: z.string().nullable(),
  lines: z.array(z.string()),
  prompt: z.string(),
  failed: z.string().nullable(),
});
type Turn = z.infer<typeof Turn>;
const Call = z.object({
  turn: z.string(),
  contextChars: z.number(),
  inputTokens: z.number().nullable(),
  firstTokenMs: z.number().nullable(),
  doneMs: z.number(),
});
type Call = z.infer<typeof Call>;
const Session = z.object({
  preset: z.string(),
  session: z.string(),
  runID: z.string().nullable(),
  premise: z.string(),
  turns: z.array(Turn),
  calls: z.array(Call).default([]),
});
type Session = z.infer<typeof Session>;

const Snapshot = z.object({
  phase: z.string(),
  heldReady: z.boolean(),
  locked: z.string().nullable(),
  runID: z.string(),
  inputs: z.array(
    z.object({
      inputID: z.string(),
      outcome: z.string(),
      firstFrameAt: z.number().nullable(),
      failed: z.string().nullable(),
      prompt: z.string().nullable(),
    }),
  ),
  boxed: z.array(z.string()),
  picks: z.array(z.object({ id: z.string(), label: z.string() })),
  guesses: z.array(z.object({ elementID: z.string(), likelihood: z.number().nullable() })),
  rootLines: z.array(z.string()),
  rootPrompt: z.string(),
  error: z.string().nullable(),
});
type Snapshot = z.infer<typeof Snapshot>;

const readSnapshot = `(() => {
  const controller = window.vibeUI;
  if (controller === undefined) return null;
  const state = controller.store.getState();
  const root = controller.ahead.tree.root;
  return {
    phase: state.phase,
    heldReady: state.heldReady,
    locked: state.locked,
    runID: controller.summary().runID,
    inputs: state.inputs.map((input) => ({
      inputID: input.inputID,
      outcome: input.outcome,
      firstFrameAt: input.firstFrameAt,
      failed: input.failed,
      prompt: input.prompt,
    })),
    boxed: state.boxes.map((box) => box.elementID),
    picks: state.shownView.elements
      .filter((element) => element.kind === "pick")
      .map((element) => ({ id: element.id, label: element.label })),
    guesses: state.guesses.map((guess) => ({ elementID: guess.elementID, likelihood: guess.likelihood })),
    rootLines: root?.lines ?? [],
    rootPrompt: root?.prompt ?? "",
    error: state.error,
  };
})()`;

async function snapshot(page: Page): Promise<Snapshot | null> {
  const raw: unknown = await page.evaluate(readSnapshot).catch(() => null);
  const parsed = Snapshot.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function waitFor(
  page: Page,
  predicate: (state: Snapshot) => boolean,
  timeoutMs: number,
): Promise<Snapshot | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await snapshot(page);
    if (state !== null && predicate(state)) return state;
    if (state?.phase === "ended") return null;
    await sleep(250);
  }
  return null;
}

const held = (state: Snapshot) =>
  state.heldReady && state.boxed.length > 0 && state.locked === null;

function choosePick(state: Snapshot, chosen: Map<string, number>): string | null {
  const likelihood = (id: string) =>
    state.guesses.find((guess) => guess.elementID === id)?.likelihood ?? -1;
  const boxed = state.picks.filter((element) => state.boxed.includes(element.id));
  const ranked = boxed.sort(
    (first, second) =>
      (chosen.get(first.id) ?? 0) - (chosen.get(second.id) ?? 0) ||
      likelihood(second.id) - likelihood(first.id),
  );
  return ranked[0]?.id ?? null;
}

function promptFrom(state: Snapshot): string {
  const input = state.inputs.at(-1);
  return input?.prompt != null && input.prompt !== "" ? input.prompt : state.rootPrompt;
}

const stripGuesses = (lines: readonly string[]) => {
  const end = lines.findIndex((line) => line.startsWith("?"));
  return end === -1 ? [...lines] : lines.slice(0, end);
};

async function runSession(
  context: BrowserContext,
  url: string,
  preset: string,
  session: string,
  log: (line: string) => void,
): Promise<Session> {
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    log(`${preset}/${session} page error: ${error.message}`);
  });
  const premise = readFileSync(join(root, "src", "presets", preset, "premise.md"), "utf8");
  const turns: Turn[] = [];
  let runID: string | null = null;
  let calls: Call[] = [];
  try {
    await page.goto(`${url}/?preset=${preset}&omni=mock&jev=mock&delays=${delays}`, {
      timeout: 120_000,
    });
    const opened = await waitFor(page, held, 120_000);
    if (opened === null) throw new Error("the opening never held");
    runID = opened.runID;
    log(`${preset}/${session} opened (${runID})`);
    const chosen = new Map<string, number>();
    const steps = scripts[session] ?? [];
    for (const [index, step] of steps.entries()) {
      const before = await waitFor(page, held, 60_000);
      if (before === null) {
        log(`${preset}/${session} turn ${index + 1}: never held, stopping`);
        break;
      }
      const count = before.inputs.length;
      let did: string;
      if (step.kind === "tell") {
        did = `told the world: ${step.text}`;
        await page.evaluate((text) => window.vibeUI?.input({ kind: "instruct", text }), step.text);
      } else {
        const target = choosePick(before, chosen);
        if (target === null) {
          log(`${preset}/${session} turn ${index + 1}: nothing boxed to pick, stopping`);
          break;
        }
        chosen.set(target, (chosen.get(target) ?? 0) + 1);
        did = `picked ${before.picks.find((element) => element.id === target)?.label ?? target}`;
        await page.evaluate(
          (elementID) => window.vibeUI?.input({ kind: "click", elementID }),
          target,
        );
      }
      const answered = await waitFor(
        page,
        (state) =>
          state.inputs.length > count &&
          (state.inputs.at(-1)?.firstFrameAt != null || state.inputs.at(-1)?.failed != null),
        90_000,
      );
      const after = (await waitFor(page, held, 60_000)) ?? answered ?? (await snapshot(page));
      const input = answered?.inputs.at(-1) ?? null;
      const turn: Turn = {
        turn: index + 1,
        did,
        outcome: input?.outcome ?? null,
        lines: stripGuesses(after?.rootLines ?? []),
        prompt: after === null ? "" : promptFrom(after),
        failed: input === null ? "no answer" : input.failed,
      };
      turns.push(turn);
      log(
        `${preset}/${session} turn ${turn.turn} ${did}: ${turn.outcome ?? "?"}${turn.failed === null ? "" : ` failed ${turn.failed}`}, ${turn.lines.length} lines`,
      );
    }
    calls = agentCalls(
      await page.evaluate(() => window.vibeUI?.summaryEvents() ?? []).catch(() => []),
    );
    await page.evaluate(() => window.vibeUI?.end("follow-eval")).catch(() => undefined);
  } catch (error: unknown) {
    log(`${preset}/${session} failed: ${String(error)}`);
  } finally {
    await page.close().catch(() => undefined);
  }
  return { preset, session, runID, premise, turns, calls };
}

const Done = z.looseObject({
  kind: z.literal("agent_lines_done"),
  turn: z.string(),
  aborted: z.boolean(),
  input: z.string(),
  inputTokens: z.number().nullable(),
  firstTokenMs: z.number().nullable(),
  doneMs: z.number(),
});

/** Every finished agent call among a run's events: context size and timings. */
function agentCalls(events: readonly unknown[]): Call[] {
  return events.flatMap((event) => {
    const parsed = Done.safeParse(event);
    if (!parsed.success || parsed.data.aborted) return [];
    const call = parsed.data;
    return [
      {
        turn: call.turn,
        contextChars: call.input.length,
        inputTokens: call.inputTokens,
        firstTokenMs: call.firstTokenMs,
        doneMs: call.doneMs,
      },
    ];
  });
}

const Score = z.object({
  turn: z.number(),
  asked: z.number().min(0).max(5),
  stayed: z.number().min(0).max(5).nullable(),
  fun: z.number().min(0).max(5),
  fresh: z.number().min(0).max(5),
  goal: z.number().min(0).max(5).nullable(),
  invented: z.number().min(0).max(5),
  note: z.string(),
});
const Verdict = z.object({
  turns: z.array(Score),
  evolving: z.number().min(0).max(5),
  summary: z.string(),
});
type Verdict = z.infer<typeof Verdict>;
const Response = z.looseObject({
  output: z.array(
    z.looseObject({
      type: z.string(),
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});

const rubric = readFileSync(join(root, "src", "eval", "follow-judge.md"), "utf8");

function transcript(session: Session): string {
  return [
    "# Premise",
    "",
    session.premise.trim(),
    "",
    "# Turns",
    ...session.turns.flatMap((turn) => [
      "",
      `## Turn ${turn.turn}: the person ${turn.did}`,
      turn.failed === null ? "" : `(this turn failed: ${turn.failed})`,
      "Change lines:",
      ...(turn.lines.length === 0 ? ["(none)"] : turn.lines),
      "Video prompt:",
      turn.prompt === "" ? "(none)" : turn.prompt,
    ]),
    "",
    "Score it as the JSON object the instructions describe.",
  ].join("\n");
}

async function judgeOnce(session: Session, apiKey: string): Promise<Verdict> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(240_000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: judgeModel,
          reasoning: { effort: "low" },
          instructions: rubric,
          input: transcript(session),
          text: { format: { type: "json_object" } },
        }),
      });
      if (!response.ok)
        throw new Error(`OpenAI HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const parsed = Response.parse(await response.json());
      const text = parsed.output
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .join("");
      return Verdict.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    } catch (error: unknown) {
      lastError = String(error).slice(0, 300);
    }
  }
  throw new Error(`judge failed: ${lastError}`);
}

const mean = (numbers: readonly number[]) =>
  numbers.length === 0
    ? null
    : Math.round((numbers.reduce((total, value) => total + value, 0) / numbers.length) * 100) / 100;

interface Judged {
  preset: string;
  session: string;
  passes: Verdict[];
}

function scoresOf(judged: readonly Judged[], sessions: readonly Session[]) {
  const all = judged.flatMap((entry) => {
    const session = sessions.find(
      (candidate) => candidate.preset === entry.preset && candidate.session === entry.session,
    );
    return entry.passes.flatMap((verdict) =>
      verdict.turns.map((score) => ({
        ...score,
        preset: entry.preset,
        session: entry.session,
        told: session?.turns[score.turn - 1]?.did.startsWith("told") ?? false,
      })),
    );
  });
  const of = (rows: typeof all, key: "asked" | "stayed" | "fun" | "fresh" | "goal" | "invented") =>
    mean(rows.flatMap((row) => (row[key] === null ? [] : [row[key]])));
  const evolving = (rows: readonly Judged[]) =>
    mean(rows.flatMap((entry) => entry.passes.map((verdict) => verdict.evolving)));
  const groups = [
    ["all", all, judged],
    ...presets.map(
      (preset) =>
        [
          preset,
          all.filter((row) => row.preset === preset),
          judged.filter((entry) => entry.preset === preset),
        ] as const,
    ),
  ] as const;
  return groups.map(([name, rows, entries]) => ({
    group: name,
    askedTold: of(
      rows.filter((row) => row.told),
      "asked",
    ),
    askedPick: of(
      rows.filter((row) => !row.told),
      "asked",
    ),
    stayed: of(rows, "stayed"),
    fun: of(rows, "fun"),
    fresh: of(rows, "fresh"),
    freshWander: of(
      rows.filter((row) => row.session === "wander"),
      "fresh",
    ),
    evolvingWander: evolving(entries.filter((entry) => entry.session === "wander")),
    goal: of(rows, "goal"),
    invented: of(rows, "invented"),
  }));
}

async function judgeAll(sessions: readonly Session[], log: (line: string) => void) {
  const apiKey = readEnvironment().OPENAI_API_KEY;
  if (apiKey === undefined) throw new Error("follow-eval needs OPENAI_API_KEY in .env.local");
  return Promise.all(
    sessions
      .filter((session) => session.turns.length > 0)
      .map(async (session): Promise<Judged> => {
        const verdicts = await Promise.all(
          Array.from({ length: passes }, () => judgeOnce(session, apiKey)),
        );
        log(`judged ${session.preset}/${session.session}`);
        return { preset: session.preset, session: session.session, passes: verdicts };
      }),
  );
}

function summarize(scores: ReturnType<typeof scoresOf>, sessions: readonly Session[]): string {
  const cell = (value: number | null) => (value === null ? "  -  " : value.toFixed(2));
  const calls = (kind: string, rows: readonly Call[]) => rows.filter((call) => call.turn === kind);
  const timing = sessions.map((session) => {
    const responds = calls("respond", session.calls);
    const contexts = responds.map((call) => call.contextChars);
    return `${`${session.preset}/${session.session}`.padEnd(24)} respond ${String(responds.length).padStart(2)}: first token ${cell(mean(responds.flatMap((call) => (call.firstTokenMs === null ? [] : [call.firstTokenMs / 1000]))))} s, done ${cell(mean(responds.map((call) => call.doneMs / 1000)))} s, context ${String(contexts[0] ?? 0)} to ${String(contexts.at(-1) ?? 0)} chars (max ${String(Math.max(0, ...contexts))}); speculate ${String(calls("speculate", session.calls).length)}: done ${cell(mean(calls("speculate", session.calls).map((call) => call.doneMs / 1000)))} s`;
  });
  return [
    "group            asked:told asked:pick stayed fun   fresh  fresh:wander evolving:wander goal  invented",
    ...scores.map(
      (row) =>
        `${row.group.padEnd(16)} ${cell(row.askedTold).padEnd(10)} ${cell(row.askedPick).padEnd(10)} ${cell(row.stayed).padEnd(6)} ${cell(row.fun).padEnd(5)} ${cell(row.fresh).padEnd(6)} ${cell(row.freshWander).padEnd(12)} ${cell(row.evolvingWander).padEnd(15)} ${cell(row.goal).padEnd(5)} ${cell(row.invented)}`,
    ),
    "",
    ...timing,
  ].join("\n");
}

async function main(): Promise<void> {
  const directory =
    rejudge ??
    join(
      root,
      ".agent",
      "evals",
      "follow",
      `${new Date().toISOString().replace(/[:.]/g, "-")}${label === null ? "" : `-${label}`}`,
    );
  mkdirSync(directory, { recursive: true });
  const log = createLog(join(directory, "log.txt"));
  let sessions: Session[];
  if (rejudge !== null) {
    sessions = z
      .array(Session)
      .parse(JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8")));
  } else {
    const server = await startDevServer({ port, extraArguments: ["--force"] });
    log(`dev server up on ${port}`);
    const browser = await launchBrowser();
    try {
      const queue = presets.flatMap((preset) =>
        sessionNames.map((session) => ({ preset, session })),
      );
      const done: Session[] = [];
      const worker = async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
          await seedKeys(context, keysFromEnvironment());
          try {
            done.push(await runSession(context, server.url, next.preset, next.session, log));
          } finally {
            await context.close().catch(() => undefined);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      sessions = done;
    } finally {
      await browser.close().catch(() => undefined);
      await server.stop();
    }
    writeFileSync(join(directory, "sessions.json"), `${JSON.stringify(sessions, null, 2)}\n`);
  }
  const judged = await judgeAll(sessions, log);
  writeFileSync(join(directory, "judge.json"), `${JSON.stringify(judged, null, 2)}\n`);
  const summary = summarize(scoresOf(judged, sessions), sessions);
  writeFileSync(join(directory, "summary.txt"), `${summary}\n`);
  log(`\n${summary}\nwrote ${directory}`);
}

const cleanup = registerCleanup({ timeoutMs: 1_800_000 });
main()
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => cleanup("done"));
