import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { now } from "../run-log/index.ts";
import { scenariosVersion, subscribeScenarios, type BusyKit } from "../scenario/index.ts";
import { getBusyKit } from "./busy.ts";
import { startLiveness } from "./engine.ts";
import type { LivenessState, LivenessStore, StageHandle } from "./feed.ts";
import { createGlow, type Glow } from "./glow.ts";
import { measuredPhaseSeconds } from "./history.ts";
import { nudgeStore } from "./nudge.ts";
import { phaseNames, type PhaseName } from "./phases.ts";

interface Props {
  /** The session's store. */
  store: LivenessStore;
  /** The stage to paint over, or null before it is up. */
  stage: StageHandle | null;
  pending: boolean;
  connecting: boolean;
}

/** The latest input as the busy state shows it: when it came, its phase, and since when. */
interface Latest {
  t: number;
  kind: string;
  outcome: string;
  /** The phase in progress, or null once the first frame is on screen. */
  phase: PhaseName | null;
  /** Session seconds when that phase began. */
  since: number;
}

const missDelaySeconds = 0.4;
const hitDelaySeconds = 0.9;
const slowFactor = 1.6;
const lateSeconds = 8;
const unfinishedFill = 0.94;

function useClock(running: boolean): number {
  const [time, setTime] = useState(now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setTime(now());
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  return running ? time : 0;
}

function latestInput(state: LivenessState): Latest | null {
  const last = state.inputs.at(-1);
  if (last === undefined) return null;
  const progress = state.progress?.inputID === last.inputID ? state.progress : null;
  return {
    t: last.t,
    kind: last.kind,
    outcome: last.outcome,
    phase: last.firstFrameAt !== null ? null : (progress?.phase ?? "thinking"),
    since: progress?.since ?? last.t,
  };
}

/**
 * How far along the answer is, from 0 to 1, paced by the phase timings this browser measured:
 * every finished phase counts whole and the current one by its elapsed share, held short of full
 * until the first frame lands.
 */
function progressShare(latest: Latest, time: number, expected: Record<PhaseName, number>): number {
  const current = latest.phase;
  if (current === null) return 1;
  const total = phaseNames.reduce((sum, name) => sum + expected[name], 0);
  const currentIndex = phaseNames.indexOf(current);
  const done = phaseNames.slice(0, currentIndex).reduce((sum, name) => sum + expected[name], 0);
  const elapsed = Math.min(expected[current], Math.max(0, time - latest.since));
  return Math.min(unfinishedFill, (done + elapsed) / Math.max(0.1, total));
}

/** The one short line the busy state says now, in the world's voice. */
function statusLine(
  kit: BusyKit,
  latest: Latest | null,
  connecting: boolean,
  time: number,
  expected: Record<PhaseName, number>,
): string {
  if (connecting || latest === null) return kit.phases.opening;
  const current = latest.phase;
  if (current === null) return kit.phases.arriving;
  const slow = time - latest.since > expected[current] * slowFactor + 1;
  return slow ? kit.phases.slow : kit.phases[current];
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));

function fill(colors: readonly string[], fallback: string): string {
  if (colors.length === 0) return fallback;
  if (colors.length === 1) return colors[0] ?? fallback;
  return `linear-gradient(180deg, ${colors.join(", ")})`;
}

function setVariables(node: HTMLElement | null, variables: readonly [string, string][]): void {
  if (node !== null) for (const [name, value] of variables) node.style.setProperty(name, value);
}

/** The CSS custom properties that draw a kit's panel, band and indicator, all from its data. */
function kitVariables(kit: BusyKit): [string, string][] {
  const corners =
    kit.frame.corners.length === 4 ? kit.frame.corners : kit.frame.corners.slice(0, 1);
  return [
    ["--busy-ink", kit.colors.ink],
    ["--busy-panel", kit.colors.panel],
    ["--busy-edge", kit.colors.edge],
    ["--busy-accent", kit.colors.accent],
    ["--busy-glow", kit.colors.glow],
    ["--busy-font", kit.font],
    ["--busy-fill", fill(kit.frame.panel, kit.colors.panel)],
    [
      "--busy-radius",
      (corners.length === 0 ? [0] : corners).map((corner) => `${clamp(corner, 0, 4)}cqw`).join(" "),
    ],
    ["--busy-border-width", `${clamp(kit.frame.borderWidth, 0, 1)}cqw`],
    ["--busy-border-style", kit.frame.borderStyle],
    ["--busy-letter-spacing", `${clamp(kit.frame.letterSpacing, 0, 0.2)}em`],
    ["--busy-indicator-seconds", `${clamp(kit.indicator.seconds, 0.4, 20)}s`],
  ];
}

function Ambient({ kit }: { kit: BusyKit }) {
  return (
    <div className="ambient" aria-hidden="true">
      {kit.ambient.map((effect, index) => (
        <div
          key={index}
          className="ambient-slot"
          style={{ opacity: clamp(effect.opacity, 0, 1), mixBlendMode: effect.blend }}
        >
          <div
            className={`ambient-layer ambient-${effect.kind}`}
            ref={(node) => {
              setVariables(node, [
                ["--ambient-color", effect.color],
                ["--ambient-x", `${clamp(effect.x, 0, 100)}%`],
                ["--ambient-y", `${clamp(effect.y, 0, 100)}%`],
                ["--ambient-width", `${clamp(effect.width, 1, 200)}%`],
                ["--ambient-height", `${clamp(effect.height, 1, 200)}%`],
                ["--ambient-seconds", `${clamp(effect.seconds, 0.3, 60)}s`],
              ]);
            }}
          />
        </div>
      ))}
    </div>
  );
}

function useGlow(stage: StageHandle | null, waiting: boolean): void {
  const glow = useRef<Glow | null>(null);
  useEffect(() => {
    const page = stage?.element.parentElement;
    if (stage === null || page == null) return;
    const light = document.createElement("div");
    light.className = "page-light";
    const spot = document.createElement("div");
    spot.className = "page-light-spot";
    const fill = document.createElement("div");
    fill.className = "page-light-fill";
    spot.append(fill);
    light.append(spot);
    page.prepend(light);
    const created = createGlow({
      source: stage.video,
      host: stage.element,
      onColor: (color) => {
        fill.style.backgroundColor = color;
      },
    });
    created.start();
    glow.current = created;
    return () => {
      created.destroy();
      light.remove();
      glow.current = null;
    };
  }, [stage]);
  useEffect(() => {
    glow.current?.setWaiting(waiting);
  }, [waiting, stage]);
}

/**
 * Everything that keeps the stage alive while it works, painted inside the stage over the video
 * without ever covering the picture: ambient life on the held frame, the scenario's own busy state
 * as one small quiet chip (its indicator art, one line in the world's voice and a hairline paced
 * from measured timings), a clear paused look, and the glow the picture casts around the stage and
 * onto the page.
 */
export function LivenessLayer({ store, stage, pending, connecting }: Props) {
  useEffect(() => {
    if (stage !== null) return startLiveness(store, stage);
  }, [store, stage]);
  useSyncExternalStore(subscribeScenarios, scenariosVersion);
  const state = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.getState(),
  );
  const nudges = useStore(nudgeStore, (nudge) => nudge.count);
  const expected = useMemo(() => measuredPhaseSeconds(), []);
  const busyNode = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = busyNode.current;
    if (node === null || nudges === 0) return;
    node.dataset.nudge = "false";
    node.getBoundingClientRect();
    node.dataset.nudge = "true";
  }, [nudges]);
  const loaded = getBusyKit();
  const timeline = latestInput(state);
  const framed = state.firstFrames > 0;
  const waiting = connecting || pending;
  const time = useClock(waiting);
  const paused = state.paused;
  useGlow(stage, waiting);
  if (stage === null || loaded === null) return null;
  const { kit } = loaded;
  const delay = timeline?.outcome === "hit" ? hitDelaySeconds : missDelaySeconds;
  const busy =
    connecting ||
    (pending && timeline !== null && timeline.kind !== "start" && time - timeline.t >= delay);
  const ended = state.phase === "ended";
  const held = framed && !state.playing && !ended && !paused;
  const variables = kitVariables(kit);
  const waited = connecting || timeline === null ? 0 : time - timeline.t;
  const late = waited >= lateSeconds;
  const share = connecting || timeline === null ? null : progressShare(timeline, time, expected);
  return createPortal(
    <>
      <div
        className="liveness"
        data-scenario={loaded.scenarioID}
        data-held={held}
        data-busy={busy}
        data-paused={paused}
        ref={(node) => {
          setVariables(node, variables);
        }}
      >
        {held || busy ? <Ambient kit={kit} /> : null}
        {paused ? (
          <div className="paused" data-testid="paused">
            <span className="paused-badge">
              <span className="paused-icon" aria-hidden="true" />
              Paused
            </span>
          </div>
        ) : null}
      </div>
      <div
        className="busy-dock"
        ref={(node) => {
          setVariables(node, variables);
        }}
      >
        {busy && !paused ? (
          <div
            className={`busy busy-place-${kit.place}`}
            data-shadow={kit.frame.shadow}
            data-bevel={kit.frame.bevel}
            data-case={kit.frame.textCase}
            data-weight={kit.frame.weight}
            data-text={kit.frame.textEffect}
            data-tail={kit.frame.tail}
            data-testid="busy-state"
            data-phase={timeline?.phase ?? "opening"}
            ref={busyNode}
            role="status"
            aria-live="polite"
          >
            {loaded.indicatorURL === null ? (
              <span
                className={`busy-indicator busy-indicator-drawn motion-${kit.indicator.motion}`}
                data-testid="busy-indicator-drawn"
                aria-hidden="true"
              />
            ) : (
              <img
                className={`busy-indicator motion-${kit.indicator.motion}`}
                data-pixelated={kit.frame.pixelated}
                src={loaded.indicatorURL}
                alt=""
              />
            )}
            <div className="busy-text">
              <div className="busy-line">
                <span className="busy-status">
                  {kit.frame.prefix}
                  {statusLine(kit, timeline, connecting, time, expected)}
                </span>
                {late ? (
                  <span className="busy-waited" data-testid="busy-late">
                    {Math.round(waited)} s
                  </span>
                ) : null}
              </div>
              <span className="busy-track" aria-hidden="true">
                <span
                  className="busy-fill"
                  data-indeterminate={share === null}
                  style={share === null ? undefined : { width: `${share * 100}%` }}
                />
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </>,
    stage.element,
  );
}
