import type { Moment } from "../moments/index.ts";
import type { ClipSeconds, EnqueueRequest } from "../omni/index.ts";
import type { ClipStart, Sent, SessionPool } from "../pool/index.ts";
import { record } from "../run-log/index.ts";
import type { ViewElement, View } from "../state/index.ts";

/** Every clip is this long: the shortest Omni films, and the one every timing was measured on. */
export const clipLength: ClipSeconds = 5.875;

/** One clip sent to a session, or a baked clip with no session (`slot` -1). */
export interface ClipRecord {
  slot: number;
  inputID: string | null;
  moment: Moment | null;
  stateOf: () => View;
  built: boolean;
  popped: boolean;
  played: boolean;
  prompt: string;
  /** Elements this clip's state has that the state on display did not when it was asked for. */
  introduced: string[];
  /** Elements the state on display had that this clip's state takes away. */
  removed: ViewElement[];
  refilmOf: string | null;
  start: ClipStart;
}

/** Every clip of the run by id, and what waits on each one's build. */
export class Clips {
  private readonly records = new Map<string, ClipRecord>();
  private readonly waiting = new Map<string, (() => void)[]>();

  constructor(private readonly later: (milliseconds: number, run: () => void) => void) {}

  get(clipID: string): ClipRecord | undefined {
    return this.records.get(clipID);
  }

  set(clipID: string, clip: ClipRecord): void {
    this.records.set(clipID, clip);
  }

  /**
   * Registers a moment's clip as local media with no session (`slot` -1): built, never continued
   * from, played from its local media.
   */
  local(clipID: string, moment: Moment): void {
    this.records.set(clipID, {
      slot: -1,
      inputID: null,
      moment,
      stateOf: () => moment.state,
      built: true,
      popped: false,
      played: false,
      prompt: moment.prompt,
      introduced: moment.introduced,
      removed: moment.removed,
      refilmOf: null,
      start: "pinned",
    });
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
    this.waiting.clear();
  }

  /** Runs everything waiting on a clip's build, once; call when it is built. */
  settle(clipID: string): void {
    const waiting = this.waiting.get(clipID) ?? [];
    this.waiting.delete(clipID);
    for (const run of waiting) run();
  }

  /**
   * Runs once a clip is built, or at once when it already is. With a deadline, `onMiss` runs in
   * its place when the build takes longer, and the build no longer runs it.
   */
  whenBuilt(
    clipID: string,
    run: () => void,
    deadline: { milliseconds: number; onMiss: () => void } | null = null,
  ): void {
    if (this.records.get(clipID)?.built === true) {
      run();
      return;
    }
    let settled = false;
    const once = () => {
      if (settled) return;
      settled = true;
      run();
    };
    this.waiting.set(clipID, [...(this.waiting.get(clipID) ?? []), once]);
    if (deadline !== null)
      this.later(deadline.milliseconds, () => {
        if (settled) return;
        settled = true;
        record("deadline_missed", {
          call: "source_built",
          milliseconds: deadline.milliseconds,
          clipID,
        });
        deadline.onMiss();
      });
  }
}

/** One clip to send: where it goes, what it starts from, and what it answers. */
export interface ClipOrder {
  slot: number;
  request: EnqueueRequest;
  moment: Moment | null;
  stateOf: () => View;
  inputID: string | null;
  continueFrom?: string | null;
  pinned?: Blob | null;
  fallback?: Blob | null;
  wanted?: () => boolean;
}

/**
 * Sends a clip through the pool and registers it the instant it is queued, with what its state
 * adds to and takes from the state on display (`shown`).
 */
export function sendClip(
  pool: SessionPool,
  clips: Clips,
  shown: () => View,
  order: ClipOrder,
): Promise<Sent> {
  const { request, moment, stateOf, inputID } = order;
  return pool.send(order.slot, request, {
    continueFrom: order.continueFrom ?? null,
    pinned: order.pinned ?? null,
    fallback: order.fallback ?? null,
    wanted: order.wanted ?? (() => true),
    inputID,
    guess: moment?.input?.elementID ?? null,
    onQueued: (clipID, start) => {
      const elements = shown().elements;
      const shownIDs = new Set(elements.map((element) => element.id));
      clips.set(clipID, {
        slot: order.slot,
        inputID,
        moment,
        stateOf,
        built: false,
        popped: false,
        played: false,
        prompt: request.prompt,
        introduced: stateOf()
          .elements.filter((element) => !shownIDs.has(element.id))
          .map((element) => element.id),
        removed: elements.filter(
          (element) => !stateOf().elements.some((kept) => kept.id === element.id),
        ),
        refilmOf:
          request.metadata?.startsWith("refilm ") === true ? request.metadata.slice(7) : null,
        start,
      });
    },
  });
}
