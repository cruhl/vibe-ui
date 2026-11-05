import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const usage = `pnpm report [runID]

Reads .agent/runs/<runID>.jsonl (default: the newest run) and prints per-input timings on the
session clock: click to enqueue, click to clip_queued, click to first frame, click to ready (the
first Jev boxes on the new clip, when the next input can land), build seconds, Jev latency, hits
and misses of speculation, and run totals (unanswered inputs, black frames, deadline misses, stalls, failures).`;

if (process.argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const Event = z.looseObject({ kind: z.string(), t: z.number() });
type Event = z.infer<typeof Event>;

const directory = join(import.meta.dirname, "..", ".agent", "runs");
const runID =
  process.argv[2] ??
  readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .at(-1)
    ?.replace(/\.jsonl$/, "");
if (runID === undefined) throw new Error("no runs in .agent/runs");
const events = readFileSync(join(directory, `${runID}.jsonl`), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line): Event => Event.parse(JSON.parse(line)));

const field = (event: Event | undefined, name: string): unknown => event?.[name];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) => (typeof value === "number" ? value : null);
const format = (value: number | null) => (value === null ? "-" : value.toFixed(2));

const inputs = events.filter((event) => event.kind === "input");
const hitClipIDOf = (inputID: string) =>
  text(
    field(
      events.find(
        (event) => event.kind === "speculation_hit" && field(event, "inputID") === inputID,
      ),
      "clipID",
    ),
  );
const rows = inputs.map((input) => {
  const inputID = text(field(input, "inputID"));
  const queued = events.find(
    (event) => event.kind === "clip_queued" && field(event, "inputID") === inputID,
  );
  const clipID = text(field(queued, "clipID"));
  const enqueue = events.find(
    (event) => event.kind === "enqueue" && field(event, "inputID") === inputID,
  );
  const generated = events.find(
    (event) => event.kind === "clip_generated" && field(event, "clipID") === clipID,
  );
  const firstFrame = events.find(
    (event) => event.kind === "first_frame" && field(event, "clipID") === clipID,
  );
  const response = events.find(
    (event) => event.kind === "response" && field(event, "inputID") === inputID,
  );
  const respondedAt = number(field(response, "firstFrameSeconds"));
  const respondedClipID = text(field(response, "clipID"));
  const ready = events.find(
    (event) =>
      event.kind === "boxes_ready" &&
      event.t >= input.t + (respondedAt ?? 0) &&
      field(event, "clipID") ===
        (clipID !== "" ? clipID : respondedClipID !== "" ? respondedClipID : hitClipIDOf(inputID)),
  );
  const outcome = text(field(input, "outcome"));
  const midClip = field(input, "midClip") === true;
  const hitEvent = events.find(
    (event) => event.kind === "speculation_hit" && field(event, "inputID") === inputID,
  );
  const hitClipID = text(field(hitEvent, "clipID"));
  const shownClipID = clipID !== "" ? clipID : hitClipID;
  const shownFirstFrame = events.find(
    (event) => event.kind === "first_frame" && field(event, "clipID") === shownClipID,
  );
  const inputValue = z
    .looseObject({ kind: z.string(), label: z.string().optional() })
    .parse(field(input, "input"));
  return {
    input: `${inputValue.kind} ${inputValue.label ?? ""}`.trim(),
    outcome: `${outcome}${midClip ? " mid" : ""}`,
    toEnqueue: enqueue === undefined ? null : enqueue.t - input.t,
    toQueued: queued === undefined ? null : queued.t - input.t,
    buildSeconds: number(field(generated, "buildSeconds")),
    toFirstFrame:
      respondedAt ??
      ((firstFrame ?? shownFirstFrame) === undefined
        ? null
        : (firstFrame ?? shownFirstFrame ?? input).t - input.t),
    toReady: ready === undefined ? null : ready.t - input.t,
    answered: respondedAt !== null || (firstFrame ?? shownFirstFrame) !== undefined,
  };
});

process.stdout.write(`run ${runID}\n`);
process.stdout.write(
  "input                  outcome   enqueue  queued  build  first-frame  ready\n" +
    rows
      .map(
        (row) =>
          `${row.input.padEnd(22)} ${row.outcome.padEnd(9)} ${format(row.toEnqueue).padStart(7)} ${format(row.toQueued).padStart(7)} ${format(row.buildSeconds).padStart(6)} ${format(row.toFirstFrame).padStart(12)} ${format(row.toReady).padStart(6)}`,
      )
      .join("\n") +
    "\n",
);

const median = (values: number[]) => {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted.length === 0 ? null : (sorted[Math.floor(sorted.length / 2)] ?? null);
};
const present = (values: (number | null)[]) => values.filter((value) => value !== null);
const clicks = rows.filter((row) => row.input !== "start");
const jev = present(
  events
    .filter((event) => event.kind === "boxes_ready")
    .map((event) => number(field(event, "latencyMs"))),
);
const start = events.find((event) => event.kind === "run_start");
const end = events.find((event) => event.kind === "run_end");
const endT = end?.t ?? Number.POSITIVE_INFINITY;
const count = (kind: string) =>
  events.filter((event) => event.kind === kind && event.t < endT).length;

process.stdout.write(
  [
    `session seconds: ${start === undefined || end === undefined ? "-" : (end.t - start.t).toFixed(1)}`,
    `inputs: ${rows.length} (clicks ${clicks.length}), answered with a first frame: ${rows.filter((row) => row.answered).length}`,
    `median click to enqueue: ${format(median(present(clicks.map((row) => row.toEnqueue))))} s`,
    `median click to first frame: ${format(median(present(clicks.map((row) => row.toFirstFrame))))} s`,
    `median click to ready (first boxes on the new clip): ${format(median(present(clicks.map((row) => row.toReady))))} s`,
    ...["hit", "miss"].map((kind) => {
      const group = clicks.filter((row) => row.outcome.startsWith(kind));
      return `  ${kind}: ${group.length} clicks, median click to first frame ${format(median(present(group.map((row) => row.toFirstFrame))))} s`;
    }),
    `speculation: ${count("speculation_added")} guesses, ${count("speculation_popped")} popped, ${count("guesses_ranked")} rankings`,
    `median build seconds: ${format(median(present(rows.map((row) => row.buildSeconds))))}`,
    `Jev requests: ${jev.length}, median ${median(jev) ?? "-"} ms, max ${jev.length === 0 ? "-" : Math.max(...jev)} ms`,
    `black frames logged while the session ran: ${count("black_frame")}`,
    `deadline misses: ${count("deadline_missed")}, stalls: ${count("stall")}, retries: ${count("retry")}`,
    `failures: ${["agent_failed", "enqueue_failed", "enqueue_refused", "build_stall", "play_stall", "boxes_failed", "clip_failed", "command_error"].map((kind) => `${kind} ${count(kind)}`).join(", ")}`,
  ].join("\n") + "\n",
);
