import type { ElementBox } from "../jev/index.ts";
import type { Op, ViewElement, View, World } from "../state/index.ts";

/** An input reduced to what a moment answers: which element, how, and for typing the text. */
export interface MomentInput {
  elementID: string;
  action: "click" | "type";
  text: string | null;
}

/**
 * Where a moment is: its lines exist (`written`), its clip is queued or building (`filming`), the
 * clip is built (`built`), its media and held frame are local (`captured`), it is boxed and its
 * checks passed (`ready`), or its checks or its build failed (`rejected`).
 */
export type MomentStatus = "written" | "filming" | "built" | "captured" | "ready" | "rejected";

/** How a moment's clip starts: continuing its parent's clip, pinned on a picture, or fresh. */
export type StartMode = "latent" | "pinned" | "fresh";

/** Whether a moment's own guesses at the next input have been asked for, and answered. */
export type ChildrenStatus = "none" | "writing" | "written";

/** What the held frame's checks found, kept with the moment. */
export interface MomentChecks {
  presence: number;
  introducedPresence: number | null;
  lingering: number | null;
  degradation: number | null;
  /** How far its clip's first frame is from its parent's held frame; null for a fresh clip. */
  seam: number | null;
  passed: boolean;
}

/**
 * One answer to one input, complete enough to show, click and answer again with no wait. The
 * world is never stored apart from the lines: it is replayed from the root. Live-only fields
 * (`clipID`, `slot`, `abort`) are never baked.
 */
export interface Moment {
  key: string;
  parentKey: string | null;
  input: MomentInput | null;
  /** The agent's order among its siblings. */
  index: number;
  label: string;
  lines: string[];
  ops: Op[];
  world: World;
  state: View;
  beat: string | null;
  /** How likely the parent's guess said this input is; Jev's ranking replaces it when it runs. */
  likelihood: number | null;
  /** The memory entries the input and the response append. */
  memory: { input: string; response: string };
  prompt: string;
  pictureLabels: string[];
  status: MomentStatus;
  start: StartMode | null;
  clipID: string | null;
  slot: number | null;
  /** The clip as local media (an object URL or a served file), once captured or baked. */
  clipURL: string | null;
  /** The clip's bytes once captured in this run, for the run's keeper. */
  clip: Blob | null;
  /** The held end frame at native size, once captured from the stage, a step result or a bake. */
  held: Blob | null;
  boxes: ElementBox[] | null;
  checks: MomentChecks | null;
  children: ChildrenStatus;
  baked: boolean;
  /** Elements this moment's state has that its parent's did not. */
  introduced: string[];
  /** Elements its parent's state had that this moment's takes away. */
  removed: ViewElement[];
  /** Aborts every agent and Jev call made for this moment, once, when it is pruned. */
  abort: AbortController;
  /** Times its film was refused or rejected; a moment is refilmed at most once. */
  refilms: number;
}

/**
 * Where a run keeps its moments and how far it grows, the only two things a bake and a live
 * session do differently. The engine hands it every moment that turns ready and films nothing
 * more once it is full; it never asks what kind of run it is.
 */
export interface MomentKeeper {
  /** A moment just turned ready (filmed, captured, boxed and checked), or was boxed again. */
  keep: (moment: Moment) => void;
  /** Whether the run has filmed all it keeps. */
  full: () => boolean;
}

/**
 * A 64-bit content hash of the parts, as 16 hex characters: two FNV-1a passes with different
 * offsets, each over every part and a separator.
 */
export function contentHash(...parts: readonly string[]): string {
  const pass = (seed: number) => {
    let value = seed;
    for (const part of parts) {
      for (let i = 0; i < part.length; i++)
        value = Math.imul(value ^ part.charCodeAt(i), 0x01000193);
      value = Math.imul(value ^ 0x1f, 0x01000193);
    }
    return (value >>> 0).toString(16).padStart(8, "0");
  };
  return `${pass(0x811c9dc5)}${pass(0x050c5d1f)}`;
}

/** The root's key: the premise, the world file and the opening prompt. */
export function rootKey(premise: string, worldFile: string, openingPrompt: string): string {
  return contentHash("root", premise, worldFile, openingPrompt);
}

/** A moment's key: its parent's key, the input that leads to it and the answer lines. */
export function momentKey(parentKey: string, input: MomentInput, lines: readonly string[]): string {
  return contentHash(
    "moment",
    parentKey,
    input.elementID,
    input.action,
    input.text ?? "",
    ...lines,
  );
}

const normalize = (text: string | null) => (text ?? "").trim().toLowerCase();

/** Whether a moment answers an input: same element, same action, and for typing the same text. */
export function answers(moment: Moment, input: MomentInput): boolean {
  const own = moment.input;
  return (
    own !== null &&
    own.elementID === input.elementID &&
    own.action === input.action &&
    (input.action === "click" || normalize(own.text) === normalize(input.text))
  );
}

/**
 * Orders moments by likelihood, highest first, keeping the agent's order for ties and unscored
 * moments after scored ones.
 */
export function byLikelihood(moments: readonly Moment[]): Moment[] {
  return [...moments].sort(
    (first, second) =>
      (second.likelihood ?? -1) - (first.likelihood ?? -1) || first.index - second.index,
  );
}
