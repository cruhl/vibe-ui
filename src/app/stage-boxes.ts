import { cleanBoxes, heldVerdict, lingers, readyPresence } from "../boxes/index.ts";
import { getJevConnection, type Keys } from "../keys/index.ts";
import type { Memory } from "../memory/index.ts";
import type { Moment } from "../moments/index.ts";
import type { Frame } from "../frame/index.ts";
import { boxElements, jevDeadline, type BoxExtras, type ElementBox } from "../jev/index.ts";
import { now, record, withDeadline } from "../run-log/index.ts";
import type { Ahead } from "./ahead.ts";
import type { ClipRecord, Clips } from "./clips.ts";
import { guessQuestion, logJev } from "./jev-log.ts";
import { viewKey, type AppState, type InputRecord } from "./state.ts";

const sampleIntervalMs = 1500;
/** Recent memory lines Jev reads to rank guesses. */
const rankingMemory = 6;
const heldAttempts = 3;

/** What the stage's boxing asks of the controller that owns it. */
export interface StageBoxesHost {
  readonly clips: Clips;
  readonly ahead: Pick<
    Ahead,
    "tree" | "boxingOf" | "openGuesses" | "rankedCount" | "applyLikelihoods"
  >;
  readonly memory: Pick<Memory, "tail">;
  state: () => AppState;
  set: (partial: Partial<AppState>) => void;
  /** The frame on screen, or null when there is none to read. */
  frame: () => Frame | null;
  keys: () => Keys | null;
  /** The clip that answers the latest input, the one the stage is or will be showing. */
  committed: () => string | null;
  /** Whether the clip on screen has settled after its change. */
  settled: () => boolean;
  /** Whether a clip plays on stage, live or local. */
  playing: () => boolean;
  showClipState: (clipID: string) => void;
  captureHeld: (clipID: string) => void;
  saveFrame: (clipID: string, moment: string, frame?: Blob | null) => void;
  markInput: (clipID: string, partial: Partial<InputRecord>) => void;
  updateInput: (inputID: string, partial: Partial<InputRecord>) => void;
  /** Clicks waiting for boxes try again. */
  retryUnresolved: () => void;
  /** The held frame of the clip on screen failed its checks. */
  refilm: (clipID: string, clip: ClipRecord) => void;
}

/**
 * The boxes of the picture on screen: Jev asked about the frame while it plays and once it holds,
 * or a local moment's stored boxes; the held frame's checks, which refilm a clip that fails them
 * in the background; input opens on every held frame, checked or not;
 * and the pictures kept of every thing that first settles on screen.
 */
export class StageBoxes {
  /** The last frame Jev answered for, with every box it found. */
  lastFrame: { base64: string; boxes: ElementBox[]; source: string } | null = null;
  /** The last degradation score of a held frame, rounded. */
  degradation: number | null = null;
  private generation = 0;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: StageBoxesHost) {}

  /** A new clip takes the stage: boxes asked for before it are never applied. */
  invalidate(): void {
    this.generation++;
  }

  /** Asks Jev about the playing frame at a steady interval, once it has settled. */
  startSampling(): void {
    this.stopSampling();
    this.sampleTimer = setInterval(() => void this.pass("playing"), sampleIntervalMs);
  }

  stopSampling(): void {
    if (this.sampleTimer !== null) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  /** The stage shows a moment from local media: its stored boxes are the boxes, no Jev asked. */
  apply(moment: Moment): void {
    const host = this.host;
    const boxes = moment.boxes;
    if (boxes === null || moment.clipID === null) return;
    const key = viewKey(moment.state);
    host.set({ shownView: moment.state, boxes, boxesKey: key, boxesSource: "held" });
    const input = host.state().inputs.find((item) => item.clipID === moment.clipID);
    if (input !== undefined && input.boxesAt === null)
      host.updateInput(input.inputID, { boxesAt: now() });
    record("boxes_applied", { key: moment.key, clipID: moment.clipID, boxes: boxes.length });
    host.retryUnresolved();
  }

  /**
   * Holds the stage on a moment that has played, from its stored boxes: waits for its boxing if
   * it is still running, within the Jev deadline, and falls back to asking Jev about the stage
   * when the moment has none.
   */
  async hold(moment: Moment): Promise<void> {
    const host = this.host;
    const clipID = moment.clipID;
    if (clipID === null) return;
    const boxing = host.ahead.boxingOf(moment);
    if (boxing !== undefined && moment.boxes === null)
      await withDeadline("moment_boxes", jevDeadline * 2, () => boxing).catch(() => undefined);
    if (host.committed() !== clipID || host.ahead.tree.root !== moment) return;
    if (moment.boxes === null) {
      void this.held(clipID);
      return;
    }
    this.apply(moment);
    host.saveFrame(clipID, "held", moment.held);
    host.set({ heldReady: true });
    record("ready_for_input", { clipID, stored: true, rejected: moment.status === "rejected" });
  }

  /**
   * Whether the held frame of this clip is the one on stage: it answers the latest input, or the
   * refilm that answers it now is still being built.
   */
  onStage(clipID: string): boolean {
    const committed = this.host.committed();
    return (
      committed === clipID ||
      (committed !== null && this.host.clips.get(committed)?.refilmOf === clipID)
    );
  }

  /**
   * Opens input on the held frame on stage once nothing plays and no input is being answered, as
   * after a failed answer or a clip that finished off the answer's track. A view with no boxes
   * takes every click as a point. Returns whether input is open.
   */
  reopen(reason: string): boolean {
    const host = this.host;
    const state = host.state();
    if (state.phase !== "running" || state.locked !== null || state.firstFrames === 0) return false;
    if (state.playingClipID !== null || host.playing()) return false;
    this.open(host.committed(), { reason });
    return true;
  }

  /**
   * Boxes the held frame of the clip on screen and checks it shows what its state says: a frame
   * that does not is refilmed once in the background. Input opens either way, and on a frame Jev
   * could not box at all, unchecked.
   */
  async held(clipID: string): Promise<void> {
    const host = this.host;
    host.showClipState(clipID);
    host.captureHeld(clipID);
    let seen = false;
    for (let attempt = 0; attempt < heldAttempts && !seen; attempt++) {
      if (!this.onStage(clipID) || host.state().playingClipID !== null) return;
      seen = await this.pass("held");
    }
    if (!this.onStage(clipID) || host.state().playingClipID !== null) return;
    host.saveFrame(clipID, "held");
    if (!seen) {
      this.open(clipID, { checked: false });
      return;
    }
    const clip = host.clips.get(clipID);
    const found = this.lastFrame?.boxes ?? [];
    const presences = new Map(found.map((item) => [item.elementID, item.presence]));
    const introduced = clip?.introduced ?? [];
    const removed = (clip?.removed ?? []).map((element) => element.id);
    const verdict = heldVerdict(
      { introduced, removed: clip?.removed ?? [] },
      host.state().boxes,
      found,
      this.degradation,
    );
    const hundredths = (id: string) => Math.round((presences.get(id) ?? 0) * 100) / 100;
    if (verdict.lingering !== null)
      record("removal_check", {
        clipID,
        removed,
        presences: removed.map(hundredths),
        gone: !lingers(verdict.lingering),
      });
    if (verdict.introducedPresence !== null)
      record("change_check", {
        clipID,
        inputID: clip?.inputID ?? null,
        guess: clip?.moment?.input?.elementID ?? null,
        start: clip?.start ?? null,
        refilm: clip?.refilmOf !== null && clip?.refilmOf !== undefined,
        introduced,
        presences: introduced.map(hundredths),
        shown: verdict.introducedPresence >= readyPresence,
      });
    if (!verdict.passed) {
      record("frame_mismatch", {
        clipID,
        presence: verdict.presence,
        introduced,
        introducedPresence: verdict.introducedPresence,
        removed,
        lingering: verdict.lingering,
        degradation: this.degradation,
      });
      if (clip !== undefined && clip.refilmOf === null && host.committed() === clipID)
        host.refilm(clipID, clip);
    } else host.markInput(clipID, { boxesAt: now() });
    this.open(clipID, { passed: verdict.passed });
  }

  /** Marks the held frame ready for input, its view keyed so a click with no box is a point. */
  private open(clipID: string | null, detail: Record<string, unknown>): void {
    const host = this.host;
    const state = host.state();
    const key = viewKey(state.shownView);
    if (state.boxesKey !== key) host.set({ boxes: [], boxesKey: key, boxesSource: "held" });
    host.set({ heldReady: true });
    record("ready_for_input", { clipID, ...detail });
  }

  /**
   * Asks Jev for the boxes of the frame on screen, while it plays (once it has settled) or held.
   * Jev also ranks the root's open guesses when there are new ones, and scores degradation on a
   * held frame. Boxes found for a state no longer on screen are never applied.
   */
  async pass(source: "playing" | "held"): Promise<boolean> {
    const host = this.host;
    const keys = host.keys();
    if (keys === null) return false;
    const frame = host.frame();
    if (frame === null) return false;
    if (source === "playing" && !host.settled()) return false;
    const generation = this.generation;
    const state = host.state();
    const shown = state.shownView;
    const key = viewKey(shown);
    const clipID = state.playingClipID ?? host.committed();
    const removed =
      source === "held" && clipID !== null ? (host.clips.get(clipID)?.removed ?? []) : [];
    const elements = [...shown.elements, ...removed];
    const shownIDs = new Set(shown.elements.map((element) => element.id));
    const ahead = host.ahead;
    const root = ahead.tree.root;
    const ranked = ahead.openGuesses();
    const guesses =
      ranked.length < 2 || ranked.length === ahead.rankedCount ? [] : ranked.map(guessQuestion);
    const extras: BoxExtras = {
      guesses,
      recent: host.memory.tail(rankingMemory),
      degradation: source === "held",
    };
    const started = performance.now();
    record("boxes_requested", {
      source,
      clipID,
      elements: elements.length,
      guesses: guesses.length,
      frameLuma: frame.luma,
    });
    try {
      const result = await withDeadline("jev_boxes", jevDeadline, (signal) =>
        boxElements(getJevConnection(keys), frame.base64, elements, signal, extras),
      );
      this.lastFrame = { base64: frame.base64, boxes: result.boxes, source };
      logJev(source, { clipID }, frame.base64, result, Math.round(performance.now() - started));
      if (result.degradation !== null)
        this.degradation = Math.round(result.degradation * 100) / 100;
      if (result.likelihoods !== null && root !== null && root === ahead.tree.root)
        ahead.applyLikelihoods(ranked, result.likelihoods);
      if (generation !== this.generation) return true;
      if (source === "playing" && host.state().boxesSource === "held") return true;
      if (viewKey(host.state().shownView) !== key) {
        record("boxes_stale", { source, clipID });
        return true;
      }
      host.set({
        boxes: cleanBoxes(result.boxes.filter((found) => shownIDs.has(found.elementID))),
        boxesSource: source,
        boxesKey: key,
      });
      host.retryUnresolved();
      return true;
    } catch (error: unknown) {
      record("boxes_failed", { source, clipID, message: String(error) });
      return false;
    }
  }
}
