import type { AssetLibrary } from "../assets/index.ts";
import { cleanBoxes, heldVerdict, lingers, readyPresence } from "../boxes/index.ts";
import { getJevConnection, type Keys } from "../keys/index.ts";
import type { Memory } from "../memory/index.ts";
import type { Moment } from "../moments/index.ts";
import { captureFrame, captureStill, cropStill } from "../frame/index.ts";
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
  readonly ahead: Ahead;
  readonly memory: Memory;
  readonly assets: AssetLibrary;
  state: () => AppState;
  set: (partial: Partial<AppState>) => void;
  video: () => HTMLVideoElement | null;
  keys: () => Keys | null;
  /** The clip that answers the latest input, the one the stage is or will be showing. */
  committed: () => string | null;
  /** Whether the clip on screen has settled after its change. */
  settled: () => boolean;
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
 * or a local moment's stored boxes; the held frame's checks, which open input or refilm the clip;
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
    if (moment.status === "rejected") return;
    void this.pictures(clipID, moment.held);
    host.set({ heldReady: true });
    record("ready_for_input", { clipID, stored: true });
  }

  /**
   * Boxes the held frame of the clip on screen and checks it shows what its state says: a frame
   * that does not is refilmed once in the background, and one that does opens input.
   */
  async held(clipID: string): Promise<void> {
    const host = this.host;
    host.showClipState(clipID);
    host.captureHeld(clipID);
    for (let attempt = 0; attempt < heldAttempts; attempt++) {
      if (host.committed() !== clipID || host.state().playingClipID !== null) return;
      if (await this.pass("held")) break;
    }
    if (host.committed() !== clipID) return;
    host.saveFrame(clipID, "held");
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
      host.set({ boxes: [], boxesKey: null });
      if (clip !== undefined && clip.refilmOf === null) host.refilm(clipID, clip);
      return;
    }
    host.markInput(clipID, { boxesAt: now() });
    void this.pictures(clipID);
    host.set({ heldReady: true });
    record("ready_for_input", { clipID });
  }

  /**
   * Asks Jev for the boxes of the frame on screen, while it plays (once it has settled) or held.
   * Jev also ranks the root's open guesses when there are new ones, and scores degradation on a
   * held frame. Boxes found for a state no longer on screen are never applied.
   */
  async pass(source: "playing" | "held"): Promise<boolean> {
    const host = this.host;
    const video = host.video();
    const keys = host.keys();
    if (video === null || keys === null) return false;
    const frame = captureFrame(video);
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

  /**
   * Keeps a picture of every thing in view that has none yet, from the clean held frame of the
   * clip that first settled with it: a boxed thing is cropped by its box, a top-level thing
   * without a box (a room, a backdrop) keeps the whole frame. Pictures are labelled by id, so a
   * thing that leaves and returns is filmed from its picture.
   */
  private async pictures(clipID: string, held: Blob | null = null): Promise<void> {
    const host = this.host;
    const video = host.video();
    if ((video === null && held === null) || host.committed() !== clipID) return;
    const shown = host.state().shownView;
    const boxes = new Map(host.state().boxes.map((found) => [found.elementID, found]));
    const missing = Object.values(shown.world.entities).filter(
      (entity) =>
        !host.assets.has(entity.id) &&
        ((boxes.get(entity.id)?.presence ?? 0) >= readyPresence || entity.parent === null),
    );
    if (missing.length === 0) return;
    const still = held ?? (video === null ? null : await captureStill(video));
    if (still === null || host.committed() !== clipID) return;
    for (const entity of missing) {
      const box = boxes.get(entity.id) ?? null;
      const image = box === null ? still : await cropStill(still, box.box);
      if (image === null) continue;
      host.assets.add({
        label: entity.id,
        description: entity.look,
        source: box === null ? "final-frame" : "crop",
        wholeFrame: box === null,
        clipID,
        scene: shown.scene,
        degradation: this.degradation,
        createdAt: new Date().toISOString(),
        image,
      });
    }
  }
}
