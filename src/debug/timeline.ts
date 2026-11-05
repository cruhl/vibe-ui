import { z } from "zod";
import { phaseNames, type PhaseName } from "../liveness/index.ts";

const Event = z.looseObject({ kind: z.string(), t: z.number() });
type Event = z.infer<typeof Event>;

const InputEvent = z.looseObject({
  inputID: z.string(),
  outcome: z.string(),
  t: z.number(),
  input: z.looseObject({
    kind: z.string(),
    label: z.string().optional(),
    text: z.string().optional(),
  }),
});

const BeatEvent = z.looseObject({ text: z.string() });
const PhaseEvent = z.looseObject({ phase: z.string() });

/** Everything measured about one input's answer, in session seconds; null until it happens. */
export interface InputTimeline {
  inputID: string;
  t: number;
  kind: string;
  label: string;
  outcome: string;
  acknowledgedAt: number | null;
  acknowledgeMs: number | null;
  beat: string | null;
  beatAt: number | null;
  previewAt: number | null;
  previewSource: string | null;
  queuedAt: number | null;
  clipID: string | null;
  generatedAt: number | null;
  firstFrameAt: number | null;
  /** When each phase began, from `phase` events when present, else from the events around it. */
  phaseStarts: Record<PhaseName, number | null>;
  /** The phase in progress, or null once the first frame is on screen. */
  phase: PhaseName | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);
const number = (value: unknown) => (typeof value === "number" ? value : null);

function beatText(event: Event): string | null {
  const parsed = BeatEvent.safeParse(event);
  return parsed.success ? parsed.data.text : null;
}

function phaseOf(event: Event): PhaseName | null {
  const parsed = PhaseEvent.safeParse(event);
  if (!parsed.success) return null;
  return phaseNames.find((name) => name === parsed.data.phase) ?? null;
}

/**
 * Reads every input's answer out of the run log: when it was acknowledged, when the beat and the
 * preview arrived, and when its clip was queued, built and first shown. Phases come from `phase`
 * events when the agent emits them; otherwise thinking ends at the `beat` (or the answering call's
 * first token), writing at `clip_queued`, filming at `clip_generated`, arriving at `first_frame`.
 */
export function inputTimelines(rawEvents: readonly unknown[]): InputTimeline[] {
  const events = rawEvents.flatMap((raw) => {
    const parsed = Event.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const inputs = events.flatMap((event) => {
    if (event.kind !== "input") return [];
    const parsed = InputEvent.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
  return inputs.map((input, index) => {
    const next = inputs[index + 1]?.t ?? Number.POSITIVE_INFINITY;
    const own = (event: Event) => event.inputID === input.inputID;
    const after = (event: Event) => event.t >= input.t;
    const ack =
      events.find((event) => event.kind === "acknowledged" && own(event)) ??
      events.find((event) => event.kind === "acknowledge_linked" && own(event));
    const beatEvent = events.find(
      (event) =>
        event.kind === "beat" &&
        (own(event) || (event.inputID === undefined && after(event) && event.t < next)),
    );
    const respondCall = events.find(
      (event) =>
        event.kind === "agent_call_start" &&
        event.turn === "respond" &&
        after(event) &&
        event.t < next,
    );
    const firstToken =
      respondCall === undefined
        ? undefined
        : events.find(
            (event) => event.kind === "agent_first_token" && event.callID === respondCall.callID,
          );
    const preview = events.find((event) => event.kind === "preview_shown" && own(event));
    const queued = events.find((event) => event.kind === "clip_queued" && own(event));
    const hit = events.find((event) => event.kind === "speculation_hit" && own(event));
    const clipID = text(queued?.clipID) ?? text(hit?.clipID);
    const generated =
      clipID === null
        ? undefined
        : events.find((event) => event.kind === "clip_generated" && event.clipID === clipID);
    const firstFrame =
      clipID === null
        ? events.find((event) => event.kind === "first_frame" && after(event) && event.t < next)
        : events.find((event) => event.kind === "first_frame" && event.clipID === clipID);
    const marked = new Map<PhaseName, number>();
    for (const event of events)
      if (event.kind === "phase" && own(event)) {
        const name = phaseOf(event);
        if (name !== null && !marked.has(name)) marked.set(name, event.t);
      }
    const writingAt = beatEvent?.t ?? firstToken?.t ?? null;
    const phaseStarts: Record<PhaseName, number | null> = {
      thinking: marked.get("thinking") ?? input.t,
      writing: marked.get("writing") ?? writingAt,
      filming: marked.get("filming") ?? queued?.t ?? null,
      arriving: marked.get("arriving") ?? generated?.t ?? null,
    };
    const firstFrameAt = firstFrame?.t ?? null;
    const reached = phaseNames.filter((name) => phaseStarts[name] !== null);
    return {
      inputID: input.inputID,
      t: input.t,
      kind: input.input.kind,
      label: input.input.label ?? input.input.text ?? input.input.kind,
      outcome: input.outcome,
      acknowledgedAt: number(ack?.paintedT) ?? ack?.t ?? null,
      acknowledgeMs: number(ack?.ms),
      beat: beatEvent === undefined ? null : beatText(beatEvent),
      beatAt: beatEvent?.t ?? null,
      previewAt: preview?.t ?? null,
      previewSource: text(preview?.source),
      queuedAt: queued?.t ?? null,
      clipID,
      generatedAt: generated?.t ?? null,
      firstFrameAt,
      phaseStarts,
      phase: firstFrameAt === null ? (reached.at(-1) ?? "thinking") : null,
    };
  });
}
