import type { AgentInput } from "../agent/index.ts";
import type { MomentInput, MomentStatus } from "../moments/index.ts";
import type { SessionStatus } from "../omni/index.ts";
import type { ElementBox } from "../jev/index.ts";
import type { PhaseName } from "../liveness/index.ts";
import type { SlotView } from "../pool/index.ts";
import type { Scenario } from "../scenario/index.ts";
import { hashWorld, type View } from "../state/index.ts";

export type Phase = "keys" | "running" | "ended";

/** What a bake did, for `scripts/bake.ts`. */
export interface BakeReport {
  scenario: string;
  stale: string[];
  rootStale: boolean;
  behind: boolean;
  kept: number;
  filmed: number;
  written: number;
  reboxed: number;
  capped: boolean;
  failed: string | null;
}

/** A bake's progress: loading the saved tree, growing it, writing it out, or finished. */
export interface BakeState {
  phase: "loading" | "baking" | "writing" | "done" | "failed";
  report: BakeReport | null;
}

/** The latest input's progress, with the one-line beat of the change it is heading for. */
export interface Progress {
  inputID: string;
  phase: PhaseName;
  beat: string | null;
  /** Session seconds when the phase began. */
  since: number;
}

/**
 * Input from a person or a driver: a click on a box by id or at a point (fractions of the frame),
 * typed text, or a direct instruction to the agent.
 */
export type UserInput =
  | { kind: "click"; elementID: string }
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; elementID: string; text: string }
  | { kind: "instruct"; text: string };

export interface InputRecord {
  inputID: string;
  t: number;
  kind: AgentInput["kind"];
  label: string;
  outcome: "start" | "hit" | "miss";
  midClip: boolean;
  enqueuedAt: number | null;
  queuedAt: number | null;
  firstFrameAt: number | null;
  boxesAt: number | null;
  clipID: string | null;
  failed: string | null;
  /** Where the answer played from: local media, or live from a session. */
  source: "local" | "live" | null;
  /** The input as it landed, by element id, to make it once more; null for the opening. */
  again: UserInput | null;
  /** The box the input landed on, when it named one. */
  box: ElementBox | null;
  /** The prompt the answer clip was sent with, once it was sent live. */
  prompt: string | null;
}

/** A guess as the overlay and the driver see it. */
export interface GuessView {
  elementID: string;
  action: MomentInput["action"];
  status: MomentStatus;
  clipID: string | null;
  slot: number | null;
  likelihood: number | null;
  /** Whether the guess came from a saved tree. */
  baked: boolean;
}

export type { SlotView };

export interface AppState {
  phase: Phase;
  scenario: Scenario;
  sessionStatus: SessionStatus;
  trackCount: number;
  slots: SlotView[];
  activeSlot: number;
  view: View;
  boxes: ElementBox[];
  boxesSource: "playing" | "held" | null;
  heldReady: boolean;
  busy: boolean;
  playingClipID: string | null;
  inputs: InputRecord[];
  guesses: GuessView[];
  blackFrames: number;
  /** How many awaited clips have painted their first frame on stage. */
  firstFrames: number;
  /** Whether a clip plays on stage now, live from a session or from local media. */
  playing: boolean;
  error: string | null;
  progress: Progress | null;
  /** The state of the picture on screen; it moves only when the picture changes. */
  shownView: View;
  /** The input whose answer has not reached its first frame yet; every other input waits. */
  locked: string | null;
  /** The state the boxes were found for; boxes from any other state are never drawn or hit. */
  boxesKey: string | null;
  /** Paused: nothing new is asked of the agent, built or played, and input is refused. */
  paused: boolean;
  /** Which of the two local moment players is on stage instead of a session's video, if any. */
  localPlayer: 0 | 1 | null;
  /** The bake in progress, when the page runs with the `bake` parameter. */
  bake: BakeState | null;
}

/** A world's state before anything has run. */
export function initialState(scenario: Scenario): AppState {
  return {
    phase: "keys",
    scenario,
    sessionStatus: "idle",
    trackCount: 0,
    slots: [],
    activeSlot: 0,
    view: scenario.initialView,
    boxes: [],
    boxesSource: null,
    heldReady: false,
    busy: false,
    playingClipID: null,
    inputs: [],
    guesses: [],
    blackFrames: 0,
    firstFrames: 0,
    playing: false,
    error: null,
    progress: null,
    shownView: scenario.initialView,
    locked: null,
    boxesKey: null,
    paused: false,
    localPlayer: null,
    bake: null,
  };
}

/** Identifies what a state shows, so boxes found for one state are never used for another. */
export function viewKey(state: View): string {
  return hashWorld(state.world);
}
