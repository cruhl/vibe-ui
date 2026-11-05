import { z } from "zod";
import type { EvalCaseConfig } from "./case.ts";
import { checkTiming, type TimingReport } from "./timing.ts";

const TokenPrice = z.object({ input: z.number(), cachedInput: z.number(), output: z.number() });

export const Prices = z.object({
  openAI: z.record(z.string(), z.union([TokenPrice, z.string()])),
  jev: z.record(z.string(), z.union([z.object({ input: z.number() }), z.string()])),
  /** Reactor publishes no per-second Omni price: `perSecond` is the user's own estimate, or null. */
  omni: z.object({ note: z.string(), perSecond: z.number().nullable() }),
});
export type Prices = z.infer<typeof Prices>;

const Event = z.looseObject({ kind: z.string(), t: z.number(), at: z.string().optional() });
type Event = z.infer<typeof Event>;

const AgentUsage = z.object({
  inputTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
const UserLook = z.object({
  inputTokens: z.number(),
  cachedTokens: z.number(),
  outputTokens: z.number(),
  goalProgress: z.number().nullable(),
});
const UserAction = z.object({
  intentHit: z.boolean(),
  accepted: z.boolean(),
  misclicked: z.boolean(),
});

export interface Spread {
  count: number;
  p50: number | null;
  p90: number | null;
}

/** Everything one run measured: timing checks, latency spreads, tokens, dollars, user facts. */
export interface EvalReport {
  ok: boolean;
  timing: TimingReport;
  changedFrame: { all: Spread; hit: Spread; miss: Spread };
  hitRate: number | null;
  stalls: number;
  deadlineMisses: number;
  agent: {
    calls: number;
    replayed: boolean;
    outputTokensPerInput: number | null;
    inputTokensPerInput: number | null;
    cachedShare: number | null;
  };
  /** Dollars by call; `omni` is null while no Omni estimate is set, and `session` leaves it out. */
  dollars: {
    agent: number;
    jev: number;
    omni: number | null;
    session: number;
    simulatedUser: number;
  };
  user: {
    looks: number;
    actions: number;
    accepted: number;
    intentHits: number;
    misclicks: number;
    goalProgress: number | null;
  };
  clock: { contentSeconds: number | null; wallSeconds: number | null; speed: number };
  turns: TurnReport;
  liveness: LivenessReport;
}

/** Targets for how fast the stage answers a click, in seconds. */
export const livenessGoals = { acknowledge: 0.1, preview: 2.5, firstFrame: 6 } as const;

/**
 * How soon each input was answered on screen: click to the element reacting on the video
 * (`acknowledged` or `acknowledge_linked`), click to the predicted still of a miss
 * (`preview_shown`), and click to the real first frame of its clip.
 */
export interface LivenessReport {
  acknowledge: Spread;
  preview: Spread;
  firstFrame: Spread;
  misses: number;
}

function livenessReport(events: readonly Event[], timing: TimingReport): LivenessReport {
  const acknowledged = new Map<string, number>();
  for (const event of events)
    if (
      (event.kind === "acknowledged" || event.kind === "acknowledge_linked") &&
      typeof event.inputID === "string" &&
      typeof event.ms === "number" &&
      !acknowledged.has(event.inputID)
    )
      acknowledged.set(event.inputID, event.ms / 1000);
  const previews = new Map(
    events.flatMap((event) =>
      event.kind === "preview_shown" &&
      typeof event.inputID === "string" &&
      typeof event.secondsFromClick === "number"
        ? [[event.inputID, event.secondsFromClick] as const]
        : [],
    ),
  );
  const pick = (values: Map<string, number>) =>
    timing.inputs.flatMap((input) => {
      const value = values.get(input.inputID);
      return value === undefined ? [] : [round(value, 3)];
    });
  return {
    acknowledge: spread(pick(acknowledged)),
    preview: spread(pick(previews)),
    firstFrame: spread(
      timing.inputs.flatMap((input) =>
        input.clickToFirstFrame === null ? [] : [input.clickToFirstFrame],
      ),
    ),
    misses: timing.inputs.filter((input) => input.speculated === false).length,
  };
}

/**
 * The agent's answers to inputs: output tokens per answer (reported usage, or characters / 4 for
 * a line stream stopped at the guess limit, which reports none), seconds from the input to the moment
 * the clip could be enqueued, estimated tokens written by then, how many answers were valid on the
 * first try, the answer lines and guesses the code rejected, answers asked again after a rejected
 * state.
 */
export interface TurnReport {
  answers: number;
  outputTokens: Spread;
  readySeconds: Spread;
  readyTokens: Spread;
  validRate: number | null;
  rejectedLines: number;
  rejectedGuesses: number;
  reasked: number;
}

function turnReport(events: readonly Event[]): TurnReport {
  const of = (kind: string) => events.filter((event) => event.kind === kind);
  const answerCalls = new Set(
    of("agent_call_start")
      .filter((event) => event.turn === "respond")
      .map((event) => event.callID),
  );
  const reported = new Map(
    of("agent_usage").flatMap((event) =>
      typeof event.outputTokens === "number" ? [[event.callID, event.outputTokens] as const] : [],
    ),
  );
  const streamed = new Map(
    of("agent_lines_done").flatMap((event) =>
      typeof event.outputChars === "number"
        ? [[event.callID, Math.ceil(event.outputChars / 4)] as const]
        : [],
    ),
  );
  const outputTokens = [...answerCalls].flatMap((callID) => {
    const tokens = reported.get(callID) ?? streamed.get(callID);
    return tokens === undefined ? [] : [tokens];
  });
  const ready = of("turn_ready");
  const valid = of("turn_valid");
  return {
    answers: answerCalls.size,
    outputTokens: spread(outputTokens),
    readySeconds: spread(
      ready.flatMap((event) =>
        typeof event.readyMs === "number" ? [round(event.readyMs / 1000)] : [],
      ),
    ),
    readyTokens: spread(
      ready.flatMap((event) =>
        typeof event.readyChars === "number" ? [Math.ceil(event.readyChars / 4)] : [],
      ),
    ),
    validRate:
      valid.length === 0
        ? null
        : round(valid.filter((event) => event.valid === true).length / valid.length),
    rejectedLines: of("line_rejected").length,
    rejectedGuesses: of("guess_rejected").length + of("candidate_unknown_element").length,
    reasked: of("state_rejected").length,
  };
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((first, second) => first - second);
  const at = (fraction: number) =>
    sorted.length === 0
      ? null
      : (sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? null);
  return { count: sorted.length, p50: at(0.5), p90: at(0.9) };
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function tokenPrice(prices: Prices, model: string): z.infer<typeof TokenPrice> | null {
  const price = prices.openAI[model];
  return typeof price === "object" ? price : null;
}

function wallSeconds(from: Event | undefined, to: Event | undefined): number | null {
  if (from?.at === undefined || to?.at === undefined) return null;
  return (Date.parse(to.at) - Date.parse(from.at)) / 1000;
}

/** Builds the full report of one run from its run log, the case's deadlines, and prices. */
export function buildReport(
  rawEvents: readonly unknown[],
  deadlines: EvalCaseConfig["deadlines"],
  prices: Prices,
): EvalReport {
  const events = rawEvents.flatMap((raw) => {
    const parsed = Event.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const timing = checkTiming(events, deadlines);
  const of = (kind: string) => events.filter((event) => event.kind === kind);
  const changed = (outcome: boolean | null) =>
    spread(
      timing.inputs.flatMap((input) =>
        input.clickToChangedFrame === null || (outcome !== null && input.speculated !== outcome)
          ? []
          : [input.clickToChangedFrame],
      ),
    );
  const hits = timing.inputs.filter((input) => input.speculated === true).length;
  const misses = timing.inputs.filter((input) => input.speculated === false).length;

  const usages = of("agent_usage").flatMap((event) => {
    const parsed = AgentUsage.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  const sum = (values: (number | null)[]) =>
    values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const inputTokens = sum(usages.map((usage) => usage.inputTokens));
  const cachedTokens = sum(usages.map((usage) => usage.cachedTokens));
  const cutCaptures = of("agent_capture").flatMap((event) => {
    const capture = z
      .object({ usage: z.unknown().nullable(), deltas: z.array(z.unknown()) })
      .safeParse(event.capture);
    return capture.success && capture.data.usage === null ? [capture.data.deltas.length] : [];
  });
  const outputTokens = sum(usages.map((usage) => usage.outputTokens)) + sum(cutCaptures);
  const inputCount = of("input").length;
  const replayed = of("agent_replay_served").length > 0;
  const ranModel = of("agent_call_start").find((event) => typeof event.model === "string")?.model;
  const agentPrice = typeof ranModel === "string" ? tokenPrice(prices, ranModel) : null;
  const tokenDollars = (
    price: z.infer<typeof TokenPrice> | null,
    input: number,
    cached: number,
    output: number,
  ) =>
    price === null
      ? 0
      : ((input - cached) * price.input + cached * price.cachedInput + output * price.output) /
        1_000_000;
  const agentDollars = replayed
    ? 0
    : tokenDollars(agentPrice, inputTokens, cachedTokens, outputTokens);

  const jevDollars = of("boxes_ready").reduce((total, event) => {
    const price = typeof event.model === "string" ? prices.jev[event.model] : undefined;
    const tokens = typeof event.inputTokens === "number" ? event.inputTokens : 0;
    return total + (typeof price === "object" ? (tokens * price.input) / 1_000_000 : 0);
  }, 0);

  const mock = events.some((event) => event.kind === "omni_status" && event.mock === true);
  const ready = events.find((event) => event.kind === "omni_status" && event.status === "ready");
  const omniEnd = of("omni_end")[0] ?? of("run_end")[0];
  const omniSeconds = mock ? 0 : (wallSeconds(ready, omniEnd) ?? 0);
  const omniDollars = prices.omni.perSecond === null ? null : omniSeconds * prices.omni.perSecond;

  const looks = of("eval_look").flatMap((event) => {
    const parsed = UserLook.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  const userPrice = tokenPrice(prices, "gpt-5.4-nano");
  const userDollars = tokenDollars(
    userPrice,
    sum(looks.map((look) => look.inputTokens)),
    sum(looks.map((look) => look.cachedTokens)),
    sum(looks.map((look) => look.outputTokens)),
  );
  const actions = of("eval_action").flatMap((event) => {
    const parsed = UserAction.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  const progress = looks.flatMap((look) => (look.goalProgress === null ? [] : [look.goalProgress]));

  const runStart = of("run_start")[0];
  const runEnd = of("run_end")[0];
  const clockEvent = of("content_clock")[0];
  const perInput = (value: number) => (inputCount === 0 ? null : round(value / inputCount, 1));
  return {
    ok: timing.ok,
    timing,
    changedFrame: { all: changed(null), hit: changed(true), miss: changed(false) },
    hitRate: hits + misses === 0 ? null : round(hits / (hits + misses)),
    stalls: of("stall").length + of("eval_stall").length,
    deadlineMisses:
      of("deadline_missed").length + timing.inputs.filter((input) => !input.ok).length,
    agent: {
      calls: usages.length + cutCaptures.length,
      replayed,
      outputTokensPerInput: perInput(outputTokens),
      inputTokensPerInput: perInput(inputTokens),
      cachedShare: inputTokens === 0 ? null : round(cachedTokens / inputTokens),
    },
    dollars: {
      agent: round(agentDollars, 4),
      jev: round(jevDollars, 4),
      omni: omniDollars === null ? null : round(omniDollars, 4),
      session: round(agentDollars + jevDollars + (omniDollars ?? 0), 4),
      simulatedUser: round(userDollars, 4),
    },
    user: {
      looks: looks.length,
      actions: actions.length,
      accepted: actions.filter((action) => action.accepted).length,
      intentHits: actions.filter((action) => action.intentHit).length,
      misclicks: actions.filter((action) => action.misclicked).length,
      goalProgress: progress.at(-1) ?? null,
    },
    clock: {
      contentSeconds:
        runStart === undefined || runEnd === undefined ? null : round(runEnd.t - runStart.t, 1),
      wallSeconds: (() => {
        const seconds = wallSeconds(runStart, runEnd);
        return seconds === null ? null : round(seconds, 1);
      })(),
      speed: typeof clockEvent?.speed === "number" ? clockEvent.speed : 1,
    },
    turns: turnReport(events),
    liveness: livenessReport(events, timing),
  };
}

const show = (value: number | null, unit = "") => (value === null ? "-" : `${value}${unit}`);
const showSpread = (value: Spread) =>
  `${show(value.p50, "s")}/${show(value.p90, "s")} (n${value.count})`;

const goal = (value: Spread, target: number) =>
  `p50/p90 ${showSpread(value)} goal ${target}s ${value.p90 === null ? "unmeasured" : value.p90 <= target ? "met" : "missed"}`;

/** The one-line summary of a run, every field named. */
export function summarizeReport(name: string, mode: string, report: EvalReport): string {
  const failed = [
    ...new Set(report.timing.checks.filter((check) => !check.ok).map((check) => check.name)),
  ];
  return [
    report.ok ? "PASS" : "FAIL",
    name,
    mode,
    `inputs ${report.timing.inputs.length}`,
    `first frame ${show(report.timing.timeToFirstClip, "s")}`,
    `changed frame p50/p90 all ${showSpread(report.changedFrame.all)} hit ${showSpread(report.changedFrame.hit)} miss ${showSpread(report.changedFrame.miss)}`,
    `hit rate ${show(report.hitRate)}`,
    `stalls ${report.stalls}`,
    `black ${report.timing.blackFrameEvents}`,
    `deadline misses ${report.deadlineMisses}`,
    `agent out/in tokens per input ${show(report.agent.outputTokensPerInput)}/${show(report.agent.inputTokensPerInput)} cached ${show(report.agent.cachedShare)}${report.agent.replayed ? " (replayed)" : ""}`,
    `session $${report.dollars.session.toFixed(4)} (agent ${report.dollars.agent.toFixed(4)}, jev ${report.dollars.jev.toFixed(4)}, omni ${report.dollars.omni === null ? "unpriced" : report.dollars.omni.toFixed(4)}; sim user $${report.dollars.simulatedUser.toFixed(4)})`,
    `user actions ${report.user.actions} accepted ${report.user.accepted} intent hits ${report.user.intentHits} misclicks ${report.user.misclicks} goal ${show(report.user.goalProgress)}`,
    `answers ${report.turns.answers} out tokens p50/p90 ${show(report.turns.outputTokens.p50)}/${show(report.turns.outputTokens.p90)} ready ${showSpread(report.turns.readySeconds)} ready tokens p50 ${show(report.turns.readyTokens.p50)} valid ${show(report.turns.validRate)} rejected lines ${report.turns.rejectedLines} guesses ${report.turns.rejectedGuesses} reasked ${report.turns.reasked}`,
    `goals: click to acknowledgement ${goal(report.liveness.acknowledge, livenessGoals.acknowledge)}, click to preview frame ${goal(report.liveness.preview, livenessGoals.preview)} of ${report.liveness.misses} misses, click to real first frame ${goal(report.liveness.firstFrame, livenessGoals.firstFrame)}`,
    `content ${show(report.clock.contentSeconds, "s")} wall ${show(report.clock.wallSeconds, "s")} x${report.clock.speed}`,
    failed.length === 0 ? "all checks pass" : `failed: ${failed.join(", ")}`,
  ].join(" | ");
}
