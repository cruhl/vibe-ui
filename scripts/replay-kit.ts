import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { ffmpegCommand } from "./plumbing.ts";

const usage = `node --experimental-strip-types scripts/replay-kit.ts <session bundle directory>... [--force]

Turns captured session bundles (.agent/sessions/<runID>/ with run-log.jsonl, clips/, agent-replay.json
and recording.webm) into replay kits under .agent/design/kits/<runID>/: every clip the session played
cut out of the recording as its own VP8 webm, each clip's prompt, length and measured build time, every
Jev answer keyed by its question text, the agent replay fixture and the person's inputs in order. A page
opened with ?kit=<runID> replays the kit through the mock Omni, Jev and agent paths (see src/eval/kit.ts).
Kits already built are kept unless --force. Prints each kit's directory.`;

const Event = z.looseObject({ kind: z.string(), t: z.number() });
type Event = z.infer<typeof Event>;
const ClipFile = z.looseObject({
  clipID: z.string(),
  request: z.looseObject({ prompt: z.string(), seconds: z.number() }),
});
const Session = z.looseObject({ runID: z.string(), preset: z.string() });
const JevExchange = z.looseObject({
  questions: z.record(
    z.string(),
    z.looseObject({ type: z.string(), instructions: z.string().optional() }),
  ),
  answers: z.record(z.string(), z.unknown()),
});
const InputEvent = z.looseObject({
  t: z.number(),
  outcome: z.string(),
  input: z.looseObject({
    kind: z.string(),
    elementID: z.string().optional(),
    text: z.string().optional(),
  }),
  event: z
    .looseObject({ x: z.number().optional(), y: z.number().optional() })
    .nullable()
    .optional(),
});

/** One kit clip: what was asked, how long it took to build, and its footage when it was played. */
export interface KitClip {
  clipID: string;
  prompt: string;
  seconds: number;
  buildSeconds: number | null;
  video: string | null;
}

/** One recorded input, in the order the person made it. */
export interface KitInput {
  t: number;
  kind: string;
  elementID: string | null;
  text: string | null;
  x: number | null;
  y: number | null;
  outcome: string;
}

/** A replay kit's manifest, read by the page at /__dev/kit/<runID>/manifest.json. */
export interface KitManifest {
  runID: string;
  preset: string;
  clips: KitClip[];
  played: string[];
  jev: Record<string, unknown[]>;
  agent: unknown;
  inputs: KitInput[];
}

const readEvents = (path: string): Event[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const parsed = Event.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });

const field = (event: Event, name: string): string | null => {
  const value = event[name];
  return typeof value === "string" ? value : null;
};

function buildTimes(events: readonly Event[]): Map<string, number> {
  const queuedAt = new Map<string, number>();
  const lastBuilt = new Map<string, number>();
  const result = new Map<string, number>();
  for (const event of events) {
    const clipID = field(event, "clipID");
    const slot = typeof event.slot === "number" ? String(event.slot) : "0";
    if (clipID === null) continue;
    if (event.kind === "clip_queued") queuedAt.set(clipID, event.t);
    if (event.kind !== "clip_generated") continue;
    const queued = queuedAt.get(clipID);
    if (queued === undefined) continue;
    const from = Math.max(queued, lastBuilt.get(slot) ?? queued);
    result.set(clipID, Math.round((event.t - from) * 1000) / 1000);
    lastBuilt.set(slot, event.t);
  }
  return result;
}

function cut(recording: string, start: number, seconds: number, output: string): boolean {
  try {
    execFileSync(
      ffmpegCommand(),
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        recording,
        "-ss",
        start.toFixed(3),
        "-t",
        seconds.toFixed(3),
        "-an",
        "-r",
        "24",
        "-c:v",
        "libvpx",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-b:v",
        "4M",
        "-auto-alt-ref",
        "0",
        output,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    return existsSync(output);
  } catch {
    return false;
  }
}

/** Builds (or keeps) the kit for one bundle and returns its directory. */
export function buildKit(bundle: string, root: string, force = false): string {
  const session = Session.parse(JSON.parse(readFileSync(join(bundle, "session.json"), "utf8")));
  const directory = join(root, ".agent", "design", "kits", session.runID);
  if (!force && existsSync(join(directory, "manifest.json"))) return directory;
  mkdirSync(join(directory, "clips"), { recursive: true });
  const events = readEvents(join(bundle, "run-log.jsonl"));
  const builds = buildTimes(events);
  const firstFrame = events.find((event) => event.kind === "recording_first_frame");
  const recordingSeconds = firstFrame?.recordingSeconds;
  const offset =
    firstFrame !== undefined && typeof recordingSeconds === "number"
      ? firstFrame.t - recordingSeconds
      : null;
  const recording = join(bundle, "recording.webm");
  const starts = events.filter((event) => event.kind === "first_frame");
  const end = events.find((event) => event.kind === "run_end")?.t ?? Number.POSITIVE_INFINITY;
  const clipFiles = existsSync(join(bundle, "clips")) ? readdirSync(join(bundle, "clips")) : [];
  const clips = clipFiles.flatMap((file) => {
    const parsed = ClipFile.safeParse(
      JSON.parse(readFileSync(join(bundle, "clips", file), "utf8")),
    );
    return parsed.success ? [parsed.data] : [];
  });
  const played: string[] = [];
  const videos = new Map<string, string>();
  if (offset !== null && existsSync(recording))
    starts.forEach((start, index) => {
      const clipID = field(start, "clipID");
      const clip = clips.find((candidate) => candidate.clipID === clipID);
      if (clipID === null || clip === undefined || played.includes(clipID)) return;
      const next = starts[index + 1]?.t ?? end;
      const seconds = Math.min(clip.request.seconds, next - start.t, end - start.t);
      if (seconds < 0.5) return;
      const name = `clips/${clipID}.webm`;
      if (cut(recording, start.t - offset, seconds, join(directory, name))) {
        played.push(clipID);
        videos.set(clipID, name);
      }
    });
  const jev: Record<string, unknown[]> = {};
  for (const event of events) {
    if (event.kind !== "jev_exchange") continue;
    const exchange = JevExchange.safeParse(event);
    if (!exchange.success) continue;
    for (const [key, question] of Object.entries(exchange.data.questions)) {
      const answer = exchange.data.answers[key];
      if (question.instructions === undefined || answer === undefined) continue;
      const id = `${question.type}|${question.instructions}`;
      (jev[id] ??= []).push(answer);
    }
  }
  const inputs: KitInput[] = events.flatMap((event) => {
    if (event.kind !== "input") return [];
    const parsed = InputEvent.safeParse(event);
    if (!parsed.success || parsed.data.input.kind === "start") return [];
    const { input, outcome, t } = parsed.data;
    return [
      {
        t,
        kind: input.kind,
        elementID: input.elementID ?? null,
        text: input.text ?? null,
        x: parsed.data.event?.x ?? null,
        y: parsed.data.event?.y ?? null,
        outcome,
      },
    ];
  });
  const agentPath = join(bundle, "agent-replay.json");
  const manifest: KitManifest = {
    runID: session.runID,
    preset: session.preset,
    clips: clips.map((clip) => ({
      clipID: clip.clipID,
      prompt: clip.request.prompt,
      seconds: clip.request.seconds,
      buildSeconds: builds.get(clip.clipID) ?? null,
      video: videos.get(clip.clipID) ?? null,
    })),
    played,
    jev,
    agent: existsSync(agentPath)
      ? JSON.parse(readFileSync(agentPath, "utf8"))
      : { source: session.runID, captures: [] },
    inputs,
  };
  const frames = join(bundle, "frames");
  if (existsSync(frames)) {
    mkdirSync(join(directory, "frames"), { recursive: true });
    for (const file of readdirSync(frames))
      copyFileSync(join(frames, file), join(directory, "frames", file));
  }
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  return directory;
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === "replay-kit.ts") {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(`${usage}\n`);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const root = join(import.meta.dirname, "..");
  for (const bundle of argv.filter((arg) => !arg.startsWith("--")))
    process.stdout.write(`${buildKit(bundle, root, argv.includes("--force"))}\n`);
}
