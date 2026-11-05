import type { Box } from "../jev/index.ts";
import type { PhaseName } from "./phases.ts";

/** One input as liveness reads it from the session's store. */
export interface LivenessInput {
  inputID: string;
  /** Session seconds of the click. */
  t: number;
  kind: string;
  label: string;
  outcome: string;
  firstFrameAt: number | null;
  failed: string | null;
  /** The box the input landed on, when it named one. */
  box: { elementID: string; box: Box } | null;
}

/** The latest input's phase and since when (session seconds). */
export interface LivenessProgress {
  inputID: string;
  phase: PhaseName;
  since: number;
}

/** What liveness reads of a session: the app's store fits it as it is. */
export interface LivenessState {
  phase: string;
  paused: boolean;
  /** Whether a clip plays on stage now, live or from local media. */
  playing: boolean;
  /** How many awaited clips have painted their first frame. */
  firstFrames: number;
  inputs: readonly LivenessInput[];
  progress: LivenessProgress | null;
}

/** A store liveness subscribes to. */
export interface LivenessStore {
  getState(): LivenessState;
  subscribe(listener: (state: LivenessState, previous: LivenessState) => void): () => void;
}

/** Where liveness paints: the stage element over the video, and the video on screen now. */
export interface StageHandle {
  element: HTMLElement;
  video: () => HTMLVideoElement | null;
}
