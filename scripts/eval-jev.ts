import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jevModel } from "../src/jev/model.ts";
import { phrase as phraseOf, phrases } from "../src/text/template.ts";
import { readEnvironment, root } from "./plumbing.ts";

const usage = `pnpm eval:jev <evalDirectory>...

Judges every answered click of finished eval runs on held frames with Jev: for each input it
sends the frame on screen at the press and the held last frame of the clip that answered it,
and asks whether the screen answered the press, whether the intended change shows, whether each element of the new state is present
and its printed words legible, and how legible all text is (0 crisp to 3 unreadable). Writes
jev-judge.json into each run directory and prints one line per run. Questions live in
src/eval/jev-judge.md. Every Jev call has a 20 second deadline.`;

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(argv.includes("--help") ? 0 : 3);
}

const jevKey = readEnvironment().TYPESAFE_API_KEY ?? "";
if (jevKey === "") throw new Error("TYPESAFE_API_KEY is missing from .env.local");
const deadlineMs = 20_000;

const phrasing = phrases(readFileSync(join(root, "src", "eval", "jev-judge.md"), "utf8"));
const phrase = (key: string, values: Record<string, string> = {}) =>
  phraseOf(phrasing, "jev-judge.md", key, values);

const Event = z.looseObject({ kind: z.string(), t: z.number() });
const Element = z.object({ id: z.string(), label: z.string(), look: z.string() });
const Snapshot = z.object({
  inputID: z.string(),
  state: z.object({ elements: z.array(Element) }),
});
const Answer = z.looseObject({
  type: z.string(),
  noul: z.number().optional(),
  score: z.number().optional(),
});
const Reply = z.object({ answers: z.record(z.string(), Answer) });

interface InputJudgment {
  inputID: string;
  label: string;
  outcome: string;
  change: string | null;
  changed: number;
  responded: number;
  presence: number;
  presentShare: number;
  legibleShare: number;
  legibility: number;
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
const round = (value: number) => Math.round(value * 100) / 100;
const base64 = (path: string) => readFileSync(path).toString("base64");

async function askJev(
  frames: Record<string, string>,
  questions: Record<string, unknown>,
): Promise<z.infer<typeof Reply>> {
  const state: Record<string, string> = {};
  const assets: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(frames)) {
    const reference = crypto.randomUUID();
    state[name] = reference;
    assets[reference] = { type: "image", format: "jpg", data_base64: base64(path) };
  }
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jevKey}`,
      "Content-Type": "application/json",
      "TypeSafe-Danger-Zone-Images": "true",
    },
    body: JSON.stringify({ model: jevModel, state, assets, questions }),
    signal: AbortSignal.timeout(deadlineMs),
  });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${await response.text()}`);
  return Reply.parse(await response.json());
}

async function judgeRun(directory: string): Promise<string> {
  const events = readFileSync(join(directory, "run.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const parsed = Event.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });
  const runStart = events.find((event) => event.kind === "run_start");
  const runID = typeof runStart?.runID === "string" ? runStart.runID : null;
  if (runID === null) throw new Error(`${directory} has no run_start`);
  const session = join(root, ".agent", "sessions", runID);
  const judgments: InputJudgment[] = [];
  for (const input of events.filter((event) => event.kind === "input")) {
    const inputID = String(input.inputID);
    const detail = z
      .object({ kind: z.string(), label: z.string().optional() })
      .safeParse(input.input);
    if (!detail.success || detail.data.kind !== "click") continue;
    const response = events.find((event) => event.kind === "response" && event.inputID === inputID);
    const clipID = response?.clipID;
    const held = events.findLast(
      (event) =>
        event.kind === "jev_exchange" && event.source === "held" && event.clipID === clipID,
    );
    const before = join(session, "inputs", `${inputID}.jpg`);
    const after = typeof held?.frame === "string" ? join(session, held.frame) : null;
    if (clipID === undefined || after === null || !existsSync(before) || !existsSync(after)) {
      process.stdout.write(`  ${inputID} skipped: no answered clip with a held frame\n`);
      continue;
    }
    const snapshot = Snapshot.safeParse(
      events.findLast((event) => event.kind === "state_snapshot" && event.inputID === inputID),
    );
    const elements = snapshot.success ? snapshot.data.state.elements : [];
    const beat = events.find((event) => event.kind === "beat" && event.inputID === inputID);
    const change = typeof beat?.text === "string" ? beat.text : null;
    const label = detail.data.label ?? "";
    const questions: Record<string, unknown> = {
      changed: {
        type: "noul",
        instructions:
          change === null ? phrase("changed-unknown", { label }) : phrase("changed", { change }),
      },
      responded: { type: "noul", instructions: phrase("changed-unknown", { label }) },
      legibility: {
        type: "score",
        instructions: phrase("legibility"),
        criteria: [0, 1, 2, 3].map((level) => phrase(`legibility-${level}`)),
      },
    };
    elements.forEach((element, index) => {
      questions[`present_${index}`] = {
        type: "noul",
        instructions: phrase("present", { look: element.look }),
      };
      questions[`legible_${index}`] = {
        type: "noul",
        instructions: phrase("legible", { label: element.label }),
      };
    });
    const reply = await askJev({ before, after }, questions);
    const noul = (key: string) => reply.answers[key]?.noul ?? 0;
    const presence = elements.map((_element, index) => noul(`present_${index}`));
    const legible = elements.map((_element, index) => noul(`legible_${index}`));
    judgments.push({
      inputID,
      label,
      outcome: String(input.outcome),
      change,
      changed: round(noul("changed")),
      responded: round(noul("responded")),
      presence: round(mean(presence)),
      presentShare: round(mean(presence.map((value) => (value >= 0.5 ? 1 : 0)))),
      legibleShare: round(mean(legible.map((value) => (value >= 0.5 ? 1 : 0)))),
      legibility: round(reply.answers.legibility?.score ?? 3),
    });
  }
  const summary = {
    inputs: judgments.length,
    changed: round(mean(judgments.map((judgment) => (judgment.changed >= 0.5 ? 1 : 0)))),
    responded: round(mean(judgments.map((judgment) => (judgment.responded >= 0.5 ? 1 : 0)))),
    presence: round(mean(judgments.map((judgment) => judgment.presence))),
    presentShare: round(mean(judgments.map((judgment) => judgment.presentShare))),
    legibleShare: round(mean(judgments.map((judgment) => judgment.legibleShare))),
    legibility: round(mean(judgments.map((judgment) => judgment.legibility))),
  };
  writeFileSync(
    join(directory, "jev-judge.json"),
    `${JSON.stringify({ summary, judgments }, null, 2)}\n`,
  );
  return `judged ${summary.inputs} | pressed element answered ${summary.responded} | intended change shown ${summary.changed} | element presence ${summary.presence} (present share ${summary.presentShare}) | labels legible ${summary.legibleShare} | legibility ${summary.legibility} (0 crisp, 3 unreadable) | ${directory}`;
}

for (const directory of argv) process.stdout.write(`${await judgeRun(directory)}\n`);
