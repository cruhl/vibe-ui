import { difference, thumbnail } from "../frame/index.ts";
import { record } from "../run-log/index.ts";

/** A frame darker than this mean luma counts as black. */
const blackLuma = 8;
/** A frame that moved more than this from the last one is still moving. */
const settledDifference = 3;
/** How long the picture must hold still to count as settled. */
const settledMs = 400;
/** A frame this different from the held frame shows the new clip's change. */
const changedDifference = 3;

/** What watching the frames on stage reports to its owner. */
export interface FrameHooks {
  /** A black frame painted. */
  black: (luma: number) => void;
  /** The awaited clip painted its first frame; `seam` is its distance from the held frame. */
  firstFrame: (clipID: string, luma: number, seam: number | null) => void;
  /** The awaited clip's picture first differs from the held frame. */
  changed: (clipID: string, difference: number) => void;
  /** The clip on stage changed and then held still. */
  settled: (clipID: string) => void;
}

/**
 * Watches every frame painted on stage: the first frame of the clip being waited on, its first
 * frame that differs from the held frame, and the moment its picture has changed and holds still,
 * so boxes and the held frame never come from the picture before.
 */
export class FrameWatch {
  private held: Uint8ClampedArray | null = null;
  private last: Uint8ClampedArray | null = null;
  private settling: {
    clipID: string;
    changed: boolean;
    stableSince: number;
    settled: boolean;
  } | null = null;
  private awaiting: { clipID: string; painted: boolean; changed: boolean } | null = null;

  constructor(private readonly hooks: FrameHooks) {}

  /** Keeps the frame on screen now as the picture a new clip is measured against. */
  holdReference(video: HTMLVideoElement | null): void {
    this.held = video === null ? null : (thumbnail(video)?.pixels ?? null);
  }

  /** Waits for a clip's first frame and its first changed frame. */
  await(clipID: string): void {
    this.awaiting = { clipID, painted: false, changed: false };
  }

  /** Whether a clip's first frame is still awaited. */
  awaitingFirstFrame(clipID: string): boolean {
    return this.awaiting?.clipID === clipID && !this.awaiting.painted;
  }

  /** Watches a clip until its picture changes and holds still; null stops watching. */
  settle(clipID: string | null): void {
    this.settling =
      clipID === null
        ? null
        : { clipID, changed: false, stableSince: performance.now(), settled: false };
  }

  /** Whether the clip being watched has settled. */
  get settled(): boolean {
    return this.settling?.settled === true;
  }

  /** The clip's picture has changed, as its state showing on screen says. */
  markChanged(clipID: string): void {
    if (this.settling?.clipID === clipID) this.settling.changed = true;
  }

  /** Takes one painted frame of the video on stage. */
  frame(video: HTMLVideoElement): void {
    const thumb = thumbnail(video);
    if (thumb === null) return;
    if (thumb.luma < blackLuma) this.hooks.black(thumb.luma);
    const moved = this.last === null ? 255 : difference(thumb.pixels, this.last);
    this.last = thumb.pixels;
    this.watchSettling(moved);
    const waiting = this.awaiting;
    if (waiting === null) return;
    if (!waiting.painted) {
      waiting.painted = true;
      this.hooks.firstFrame(
        waiting.clipID,
        thumb.luma,
        this.held === null ? null : Math.round(difference(thumb.pixels, this.held) * 10) / 10,
      );
    }
    const changed = this.held === null ? 255 : difference(thumb.pixels, this.held);
    if (!waiting.changed && changed > changedDifference) {
      waiting.changed = true;
      this.hooks.changed(waiting.clipID, changed);
    }
    if (waiting.changed) this.awaiting = null;
  }

  private watchSettling(moved: number): void {
    const settling = this.settling;
    if (settling === null || settling.settled) return;
    const at = performance.now();
    if (moved > settledDifference) settling.stableSince = at;
    if (!settling.changed || at - settling.stableSince < settledMs) return;
    settling.settled = true;
    record("frame_settled", { clipID: settling.clipID });
    this.hooks.settled(settling.clipID);
  }
}
