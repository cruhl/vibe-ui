import type { ElementBox } from "../jev/index.ts";
import type { Keys } from "../keys/index.ts";
import type { View } from "../state/index.ts";

/** What an eval reads of the session it drives. */
export interface EvalView {
  phase: string;
  view: View;
  boxes: readonly ElementBox[];
  boxesSource: string | null;
  error: string | null;
  busy: boolean;
  locked: string | null;
  heldReady: boolean;
  playingClipID: string | null;
}

/** An input the simulated user makes: a click by id or at a point, or typed text. */
export type EvalInput =
  | { kind: "click"; elementID: string }
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; elementID: string; text: string };

/** The session an eval drives, handed to it by the page root: the app's controller fits it. */
export interface EvalTarget {
  readonly store: {
    getState(): EvalView;
    subscribe(listener: (state: EvalView, previous: EvalView) => void): () => void;
  };
  /** The video on screen now. */
  readonly video: HTMLVideoElement | null;
  start(keys: Keys): void;
  input(event: EvalInput): void;
  end(reason: string): Promise<void>;
}
