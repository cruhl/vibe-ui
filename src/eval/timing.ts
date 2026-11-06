import { z } from "zod";
import type { EvalCaseConfig } from "./case.ts";

const Event = z.looseObject({ kind: z.string(), t: z.number() });
type Event = z.infer<typeof Event>;

export interface InputTiming {
  inputID: string;
  label: string;
  t: number;
  clipID: string | null;
  clickToFirstFrame: number | null;
  clickToChangedFrame: number | null;
  speculated: boolean | null;
  ok: boolean;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Every timing and failure check of one run, computed from its run log alone. */
export interface TimingReport {
  ok: boolean;
  checks: Check[];
  inputs: InputTiming[];
  timeToFirstClip: number | null;
  blackFrameEvents: number;
  holds: { clipID: string; seconds: number }[];
  speculationEvents: number;
  warnings: Record<string, number>;
  sessionSeconds: number | null;
  pacing: Pacing;
}

/**
 * Whether generation kept up: an input whose clip was still building when it arrived fell behind
 * by the time from the input to that clip's build finishing. `ahead` counts guess clips built and
 * never played, work that ran too far ahead.
 */
export interface Pacing {
  inputs: number;
  behind: number;
  waitP50: number | null;
  waitMax: number | null;
  ahead: number;
}

const stallKinds = ["stall", "deadline_missed", "build_stall", "play_stall", "eval_stall"];
const refusalKinds = ["enqueue_refused", "command_error", "clip_failed"];
const failureKinds = [
  "agent_failed",
  "agent_refused",
  "enqueue_failed",
  "play_command_failed",
  "eval_user_failed",
];
const warningKinds = ["boxes_failed", "input_ignored", "retry", "black_frame"];

const text = (value: unknown) => (typeof value === "string" ? value : "");
const round = (value: number) => Math.round(value * 100) / 100;

function inputLabel(value: unknown): string {
  const parsed = z
    .looseObject({ kind: z.string(), label: z.string().optional(), text: z.string().optional() })
    .safeParse(value);
  if (!parsed.success) return "unknown";
  const { kind, label, text: typed } = parsed.data;
  return kind === "type"
    ? `type "${typed ?? ""}" into ${label ?? ""}`
    : `${kind} ${label ?? ""}`.trim();
}

function speculationFor(events: readonly Event[], input: Event): boolean | null {
  if (input.outcome === "hit") return true;
  if (input.outcome === "miss") return false;
  const inputID = text(input.inputID);
  const related = events.filter(
    (event) => event.kind.includes("specul") && event.inputID === inputID,
  );
  if (related.length === 0) return null;
  return related.some((event) => event.kind === "speculation_hit");
}

/**
 * Checks one run log against an eval case's deadlines: time to the first clip, each input's time to
 * the first frame of the next clip to start after it, holds between clips while the next was
 * already asked for, black frames, stalls, refusals and failures. A hold is the stage's own: it
 * runs from the later of the previous clip's end and the next clip's build finishing, since a wait
 * on a build is pacing, not a hold. Events after `run_end` are ignored. Speculation events are read
 * when present and tolerated when absent.
 */
export function checkTiming(
  rawEvents: readonly unknown[],
  deadlines: EvalCaseConfig["deadlines"],
): TimingReport {
  const all = rawEvents.flatMap((raw) => {
    const parsed = Event.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const runEnd = all.find((event) => event.kind === "run_end");
  const events = runEnd === undefined ? all : all.filter((event) => event.t <= runEnd.t);
  const runStart = events.find((event) => event.kind === "run_start");
  const find = (kind: string, field: string, value: string) =>
    events.find((event) => event.kind === kind && event[field] === value);
  const count = (kinds: readonly string[]) => events.filter((event) => kinds.includes(event.kind));
  const checks: Check[] = [];

  const firstFrame = events.find((event) => event.kind === "first_frame");
  const timeToFirstClip =
    firstFrame === undefined || runStart === undefined ? null : round(firstFrame.t - runStart.t);
  checks.push({
    name: "first clip",
    ok: timeToFirstClip !== null && timeToFirstClip <= deadlines.firstClipSeconds,
    detail:
      timeToFirstClip === null
        ? "no clip ever showed a frame"
        : `${timeToFirstClip}s (deadline ${deadlines.firstClipSeconds}s)`,
  });

  const inputs = events
    .filter((event) => event.kind === "input")
    .flatMap((event): InputTiming[] => {
      const inputID = text(event.inputID);
      const label = inputLabel(event.input);
      if (label === "start") return [];
      const frame = events.find(
        (candidate) => candidate.kind === "first_frame" && candidate.t >= event.t,
      );
      const changed = events.find(
        (candidate) => candidate.kind === "first_changed_frame" && candidate.t >= event.t,
      );
      const clipID = text(frame?.clipID);
      const clickToFirstFrame = frame === undefined ? null : round(frame.t - event.t);
      return [
        {
          inputID,
          label,
          t: event.t,
          clipID: clipID === "" ? null : clipID,
          clickToFirstFrame,
          clickToChangedFrame: changed === undefined ? null : round(changed.t - event.t),
          speculated: speculationFor(events, event),
          ok: clickToFirstFrame !== null && clickToFirstFrame <= deadlines.clickToFirstFrameSeconds,
        },
      ];
    });
  for (const input of inputs.filter((candidate) => !candidate.ok))
    checks.push({
      name: "click to first frame",
      ok: false,
      detail: `${input.label} at ${input.t}s: ${input.clickToFirstFrame === null ? "never answered" : `${input.clickToFirstFrame}s`} (deadline ${deadlines.clickToFirstFrameSeconds}s)`,
    });
  if (inputs.length > 0 && inputs.every((input) => input.ok)) {
    const worst = Math.max(...inputs.map((input) => input.clickToFirstFrame ?? 0));
    checks.push({
      name: "click to first frame",
      ok: true,
      detail: `${inputs.length} inputs, worst ${worst}s (deadline ${deadlines.clickToFirstFrameSeconds}s)`,
    });
  }

  const holds = events
    .filter((event) => event.kind === "clip_started")
    .flatMap((started) => {
      const clipID = text(started.clipID);
      const queued = find("clip_queued", "clipID", clipID);
      const previousEnd = events
        .filter(
          (event) =>
            (event.kind === "clip_finished" || event.kind === "clip_stopped") &&
            event.t <= started.t,
        )
        .at(-1);
      if (queued === undefined || previousEnd === undefined || queued.t > previousEnd.t) return [];
      const built = find("clip_generated", "clipID", clipID);
      const from = Math.max(previousEnd.t, built?.t ?? previousEnd.t);
      return [{ clipID, seconds: round(started.t - from) }];
    });
  const longHolds = holds.filter((hold) => hold.seconds > deadlines.maxHoldSeconds);
  checks.push({
    name: "holds between clips",
    ok: longHolds.length === 0,
    detail:
      longHolds.length === 0
        ? `${holds.length} holds, none over ${deadlines.maxHoldSeconds}s`
        : longHolds.map((hold) => `${hold.clipID.slice(0, 8)} held ${hold.seconds}s`).join(", "),
  });

  const blackFrameEvents = count(["black_frame"]).length;
  checks.push({
    name: "black frames",
    ok: blackFrameEvents <= deadlines.maxBlackFrames,
    detail: `${blackFrameEvents} black-frame events (allowed ${deadlines.maxBlackFrames})`,
  });

  for (const [name, kinds] of [
    ["stalls", stallKinds],
    ["refusals", refusalKinds],
    ["failures", failureKinds],
  ] as const) {
    const found = count(kinds);
    checks.push({
      name,
      ok: found.length === 0,
      detail:
        found.length === 0
          ? "none"
          : found
              .map(
                (event) =>
                  `${event.kind} at ${event.t}s${typeof event.call === "string" ? ` (${event.call})` : ""}${typeof event.reason === "string" ? `: ${event.reason}` : ""}`,
              )
              .join("; "),
    });
  }

  const waits = inputs.flatMap((input) => {
    const built = events.find(
      (event) => event.kind === "clip_generated" && event.clipID === input.clipID,
    );
    return built === undefined || built.t <= input.t ? [] : [round(built.t - input.t)];
  });
  const sortedWaits = [...waits].sort((first, second) => first - second);
  const played = new Set(
    events.filter((event) => event.kind === "clip_started").map((event) => text(event.clipID)),
  );
  const guessClips = events.filter(
    (event) => event.kind === "clip_queued" && typeof event.guess === "string",
  );
  const generated = new Set(
    events.filter((event) => event.kind === "clip_generated").map((event) => text(event.clipID)),
  );
  const pacing: Pacing = {
    inputs: inputs.length,
    behind: waits.length,
    waitP50: sortedWaits[Math.floor((sortedWaits.length - 1) / 2)] ?? null,
    waitMax: sortedWaits.at(-1) ?? null,
    ahead: guessClips.filter(
      (event) => generated.has(text(event.clipID)) && !played.has(text(event.clipID)),
    ).length,
  };
  const runEndT = runEnd?.t ?? null;
  return {
    ok: checks.every((check) => check.ok),
    checks,
    inputs,
    timeToFirstClip,
    blackFrameEvents,
    holds,
    speculationEvents: events.filter((event) => event.kind.includes("specul")).length,
    warnings: Object.fromEntries(warningKinds.map((kind) => [kind, count([kind]).length])),
    sessionSeconds: runEndT === null || runStart === undefined ? null : round(runEndT - runStart.t),
    pacing,
  };
}
