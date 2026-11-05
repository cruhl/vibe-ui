import { memo, useEffect, useRef, useState } from "react";
import { phaseNames } from "../liveness/index.ts";
import { inputTimelines, type InputTimeline } from "./timeline.ts";
import { getEvents, type RunEvent } from "../run-log/index.ts";

interface DebugInput {
  inputID: string;
  t: number;
  kind: string;
  label: string;
  outcome: string;
  midClip: boolean;
  enqueuedAt: number | null;
  queuedAt: number | null;
  firstFrameAt: number | null;
  boxesAt: number | null;
  failed: string | null;
}

interface DebugGuess {
  elementID: string;
  action: string;
  status: string;
  clipID: string | null;
  slot: number | null;
  likelihood: number | null;
}

interface DebugBox {
  elementID: string;
  presence: number;
}

interface DebugState {
  phase: string;
  sessionStatus: string;
  busy: boolean;
  boxesSource: string | null;
  blackFrames: number;
  error: string | null;
  activeSlot: number;
  playingClipID: string | null;
  slots: readonly { index: number; status: string }[];
  view: unknown;
  boxes: readonly DebugBox[];
  inputs: readonly DebugInput[];
  guesses: readonly DebugGuess[];
}

const failureKinds = new Set([
  "deadline_missed",
  "clip_failed",
  "enqueue_failed",
  "enqueue_refused",
  "boxes_failed",
  "agent_aborted",
  "speculate_failed",
  "slot_failed",
  "upload_failed",
  "play_command_failed",
  "move_failed",
  "pop_failed",
  "command_error",
  "omni_error",
  "black_frame",
  "stall",
  "retry",
  "candidates_cut",
]);

const clipStages = ["clip_queued", "clip_generated", "clip_started", "cut"] as const;

const gap = (value: number | null, from: number) =>
  value === null ? "..." : `${(value - from).toFixed(2)}s`;

const summarize = (event: RunEvent): string => {
  const { kind: _kind, t: _t, at: _at, boxes: _boxes, ...rest } = event;
  return JSON.stringify(rest).slice(0, 220);
};

const numberField = (event: RunEvent, field: string): number | null => {
  const value = event[field];
  return typeof value === "number" ? value : null;
};

const textField = (event: RunEvent, field: string): string | null => {
  const value = event[field];
  return typeof value === "string" ? value : null;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="debug-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function clipRows(events: readonly RunEvent[]) {
  const rows = new Map<string, Record<string, number>>();
  for (const event of events) {
    const clipID = textField(event, "clipID");
    if (clipID === null) continue;
    const stage = clipStages.find((candidate) => candidate === event.kind);
    if (stage === undefined) continue;
    rows.set(clipID, { ...rows.get(clipID), [stage]: event.t });
  }
  return [...rows.entries()].slice(-8).reverse();
}

const offset = (value: number | null, from: number) =>
  value === null ? "-" : `+${(value - from).toFixed(2)}s`;

function PhaseRow({ timeline, now }: { timeline: InputTimeline; now: number }) {
  const end = timeline.firstFrameAt ?? now;
  const total = Math.max(0.1, end - timeline.t);
  const bounds = phaseNames.map((name, index) => {
    const start = timeline.phaseStarts[name];
    const following = phaseNames
      .slice(index + 1)
      .map((later) => timeline.phaseStarts[later])
      .find((value) => value !== null);
    return { name, start, stop: start === null ? null : (following ?? end) };
  });
  return (
    <div className="debug-phase-row" data-testid="debug-phase-row">
      <div>
        {timeline.label} ({timeline.outcome}): ack{" "}
        {timeline.acknowledgeMs === null ? "-" : `${timeline.acknowledgeMs}ms`}, beat{" "}
        {offset(timeline.beatAt, timeline.t)}, preview {offset(timeline.previewAt, timeline.t)}
        {timeline.previewSource === null ? "" : ` ${timeline.previewSource}`}, queued{" "}
        {offset(timeline.queuedAt, timeline.t)}, built {offset(timeline.generatedAt, timeline.t)},
        first frame {offset(timeline.firstFrameAt, timeline.t)}
      </div>
      <div className="debug-phase-bar">
        {bounds.map(({ name, start, stop }) =>
          start === null || stop === null ? null : (
            <span
              key={name}
              className={`debug-phase debug-phase-${name}`}
              style={{
                left: `${((start - timeline.t) / total) * 100}%`,
                width: `${(Math.max(0, stop - start) / total) * 100}%`,
              }}
              title={`${name} ${(stop - start).toFixed(2)}s`}
            >
              {name} {(stop - start).toFixed(1)}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

const repaintMs = 300;

/**
 * Everything the run knows, painted beside the video while debug mode is on, repainted at most
 * every 300 ms so a busy log never starves the page it is watching.
 */
export function DebugPanel({ state }: { state: DebugState }) {
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  const [shown, setShown] = useState({ state, count: getEvents().length });
  useEffect(() => {
    const repaint = () => {
      setShown((current) =>
        current.state === latest.current && current.count === getEvents().length
          ? current
          : { state: latest.current, count: getEvents().length },
      );
    };
    const timer = setInterval(repaint, repaintMs);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <DebugBody state={shown.state} count={shown.count} />;
}

const DebugBody = memo(function DebugBody({ state }: { state: DebugState; count: number }) {
  const events = getEvents();
  const builds = events.filter((event) => event.kind === "clip_generated").slice(-5);
  const jev = events.filter((event) => event.kind === "boxes_ready").slice(-5);
  const failures = events.filter((event) => failureKinds.has(event.kind));
  const misses = events.filter((event) => event.kind === "deadline_missed").length;
  return (
    <aside className="debug-panel" data-testid="debug-panel">
      <Section title="session">
        <div>
          {state.sessionStatus} / {state.phase} / {state.busy ? "working" : "idle"} / boxes{" "}
          {state.boxes.length} {state.boxesSource ?? "none"} / black frames {state.blackFrames}
        </div>
        <div>
          pool{" "}
          {state.slots
            .map((slot) => `${slot.index === state.activeSlot ? "*" : ""}${slot.status}`)
            .join(" ")}
        </div>
        <div>playing {state.playingClipID ?? "none"}</div>
        {state.error === null ? null : <div className="debug-bad">{state.error}</div>}
      </Section>
      <Section title="timings (click to enqueue, to first frame)">
        {state.inputs
          .slice(-6)
          .reverse()
          .map((input) => (
            <div key={input.inputID}>
              {input.label} ({input.outcome}
              {input.midClip ? ", mid-clip" : ""}): enqueue {gap(input.enqueuedAt, input.t)}, first
              frame {gap(input.firstFrameAt, input.t)}, boxes {gap(input.boxesAt, input.t)}
              {input.failed === null ? null : (
                <span className="debug-bad"> failed {input.failed}</span>
              )}
            </div>
          ))}
      </Section>
      <Section title="phase timeline (click to first frame)">
        {inputTimelines(events)
          .filter((timeline) => timeline.kind !== "start")
          .slice(-6)
          .reverse()
          .map((timeline) => (
            <PhaseRow key={timeline.inputID} timeline={timeline} now={events.at(-1)?.t ?? 0} />
          ))}
      </Section>
      <Section title="build seconds and Jev latency">
        <div>
          build:{" "}
          {builds
            .map((event) => numberField(event, "buildSeconds")?.toFixed(1) ?? "?")
            .join(", ") || "none"}
        </div>
        <div>
          jev ms:{" "}
          {jev.map((event) => Math.round(numberField(event, "latencyMs") ?? 0)).join(", ") ||
            "none"}
        </div>
      </Section>
      <Section title={`deadline misses ${misses}, failures ${failures.length}`}>
        {failures
          .map((event, index) => ({ event, index }))
          .slice(-8)
          .reverse()
          .map(({ event, index }) => (
            <div key={index} className="debug-bad">
              {event.t.toFixed(2)} {event.kind} {summarize(event)}
            </div>
          ))}
      </Section>
      <Section title="clip queue">
        {clipRows(events).map(([clipID, stages]) => (
          <div key={clipID}>
            {clipID.slice(0, 8)}{" "}
            {clipStages
              .map((stage) => `${stage.replace("clip_", "")} ${stages[stage]?.toFixed(1) ?? "-"}`)
              .join(" / ")}
          </div>
        ))}
      </Section>
      <Section title="speculation candidates">
        {state.guesses.length === 0 ? <div>none</div> : null}
        {state.guesses.map((guess) => (
          <div key={`${guess.elementID}-${guess.action}`}>
            {guess.action} {guess.elementID}: {guess.status}, slot {guess.slot ?? "-"}, likelihood{" "}
            {guess.likelihood === null ? "-" : guess.likelihood.toFixed(2)}
          </div>
        ))}
      </Section>
      <Section title="state">
        <pre>{JSON.stringify(state.view, null, 1)}</pre>
      </Section>
      <Section title={`event log (${events.length})`}>
        {events
          .map((event, index) => ({ event, index }))
          .slice(-200)
          .reverse()
          .map(({ event, index }) => (
            <div key={index} className="debug-event">
              <span className="debug-time">{event.t.toFixed(3)}</span>
              <span className="debug-kind">{event.kind}</span>
              <span>{summarize(event)}</span>
            </div>
          ))}
      </Section>
    </aside>
  );
});
