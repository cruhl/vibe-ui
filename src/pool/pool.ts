import { z } from "zod";
import { captureFile } from "../capture/index.ts";
import { hashText } from "../text/index.ts";
import {
  type EnqueueRequest,
  type FileRef,
  type OmniClient,
  type OmniFactory,
  type OmniMessage,
  type ReactorAccess,
  type SessionStatus,
} from "../omni/index.ts";
import { record, withDeadline } from "../run-log/index.ts";

/** A session start Reactor refused for the account's rate of new sessions, with its hinted wait. */
const RateLimited = z.object({
  code: z.literal("RATE_LIMITED"),
  retry_after_ms: z.number().nullish(),
});
const rateLimitMaxMs = 8000;
/** How many of a session's last built clips it keeps, so a new clip can continue one of them. */
const retainedClips = 8;
/** How long a send waits for a session that is not ready yet. */
const slotReadyMs = 3000;
const uploadCacheSize = 40;

/**
 * One Omni session of the pool. Slot 0 opens first; the others are warm helpers that film guesses
 * in parallel. Whichever slot holds the clip on screen is the active one.
 */
export interface Slot {
  index: number;
  client: OmniClient;
  ready: boolean;
  failed: boolean;
  readyPromise: Promise<boolean>;
  resolveReady: (ready: boolean) => void;
  builtOrder: string[];
  playingClipID: string | null;
  pendingPlayClipID: string | null;
  video: HTMLVideoElement | null;
  uploads: Map<Blob, Promise<FileRef | null>>;
  inFlight: Set<string>;
  /** Sends on their way to this slot, counted against its budget before they land. */
  sending: number;
}

/** One session of the pool as the stage sees it. */
export interface SlotView {
  index: number;
  status: SessionStatus;
  trackCount: number;
}

/** What the pool asks of its owner. */
export interface PoolHooks {
  running: () => boolean;
  /** Resolves at once, or once a paused owner resumes. */
  whenOpen: () => Promise<void>;
  onStatus: () => void;
  onMessage: (slot: Slot, message: OmniMessage) => void;
  /** A slot's start settled, ready or not. */
  onStarted: (slot: Slot) => void;
  onStartFailed: (slot: Slot, error: unknown) => void;
  later: (milliseconds: number, run: () => void) => void;
}

/** Where a clip is sent from: a clip to continue, a picture to pin, and what to do if refused. */
export interface SendFrom {
  continueFrom: string | null;
  pinned: Blob | null;
  /** Pinned on this when a continuation is refused; fresh when null. */
  fallback: Blob | null;
  /** Checked the moment before the command is sent; once it says no, nothing is sent. */
  wanted: () => boolean;
  inputID: string | null;
  /** The guessed element the clip answers, for the log. */
  guess: string | null;
  /** Called the instant the clip is queued, before anything else hears of it. */
  onQueued: (clipID: string, start: ClipStart) => void;
}

/** How a sent clip starts: pinned on a picture, continuing a clip, or fresh. */
export type ClipStart = "pinned" | "continued" | "fresh";

/** Why a clip was not sent. */
export type Unsent = "ended" | "slot not ready" | "not wanted" | "refused";

export type Sent = { sent: true; clipID: string } | { sent: false; reason: Unsent };

const uploadedFiles = new WeakMap<Blob, string>();
let uploadCount = 0;

/**
 * The pool of Omni sessions: starts them, caches uploads per session, and sends clips with the
 * continuation retry. It knows nothing about moments; its owner decides what to film where.
 */
export class SessionPool {
  private slots: Slot[] = [];
  private createClient: OmniFactory | null = null;

  constructor(
    private readonly access: () => ReactorAccess,
    private readonly hooks: PoolHooks,
  ) {}

  get all(): readonly Slot[] {
    return this.slots;
  }

  slot(index: number): Slot | undefined {
    return this.slots[index];
  }

  /** Creates `size` sessions with `createClient` (live Omni or the stand-in), all started at once. */
  open(size: number, createClient: OmniFactory): void {
    this.createClient = createClient;
    for (let index = 0; index < size; index++) this.slots.push(this.createSlot(index));
    for (const slot of this.slots) this.startSlot(slot);
  }

  /** Replaces every session with a fresh one, all started at once. */
  reconnect(): void {
    const size = this.slots.length;
    this.slots = [];
    for (let index = 0; index < size; index++) this.slots.push(this.createSlot(index));
    for (const slot of this.slots) this.startSlot(slot);
  }

  private newClient(): OmniClient {
    if (this.createClient === null) throw new Error("the pool was never opened");
    return this.createClient(this.access());
  }

  private createSlot(index: number): Slot {
    let resolveReady: (ready: boolean) => void = () => undefined;
    const readyPromise = new Promise<boolean>((resolve) => {
      resolveReady = resolve;
    });
    const slot: Slot = {
      index,
      client: this.newClient(),
      ready: false,
      failed: false,
      readyPromise,
      resolveReady,
      builtOrder: [],
      playingClipID: null,
      pendingPlayClipID: null,
      video: null,
      uploads: new Map(),
      inFlight: new Set(),
      sending: 0,
    };
    this.listen(slot);
    return slot;
  }

  /** Hears a slot's client, until the slot moves on to a new one. */
  private listen(slot: Slot): void {
    const client = slot.client;
    client.onStatus(() => {
      if (slot.client === client) this.hooks.onStatus();
    });
    client.onMessage((message) => {
      if (slot.client === client) this.hooks.onMessage(slot, message);
    });
  }

  /**
   * Replaces one wedged session with a fresh one in the same slot: the old session is ended,
   * which discards whatever it was building, everything it held is forgotten, and the new one
   * starts at once. Late messages from the old session are ignored.
   */
  recycle(slotIndex: number, reason: string): void {
    const slot = this.slots[slotIndex];
    if (slot === undefined || !this.hooks.running()) return;
    record("slot_recycled", { slot: slotIndex, reason, dropped: [...slot.inFlight] });
    void slot.client.end(reason).catch((error: unknown) => {
      record("slot_end_failed", { slot: slotIndex, message: String(error) });
    });
    slot.readyPromise = new Promise<boolean>((resolve) => {
      slot.resolveReady = resolve;
    });
    slot.ready = false;
    slot.failed = false;
    slot.builtOrder = [];
    slot.playingClipID = null;
    slot.pendingPlayClipID = null;
    slot.uploads = new Map();
    slot.inFlight.clear();
    slot.client = this.newClient();
    this.listen(slot);
    this.startSlot(slot);
    this.hooks.onStatus();
  }

  /**
   * Starts one slot's session. A session refused for the account's rate of new sessions is
   * started again once, on a new client, after the wait Reactor names (at most `rateLimitMaxMs`).
   */
  private startSlot(slot: Slot, retried = false): void {
    if (!this.hooks.running()) return;
    record("slot_starting", { slot: slot.index, retried });
    slot.client
      .start()
      .then(() => {
        slot.ready = this.hooks.running();
        record(slot.ready ? "slot_ready" : "slot_ready_after_end", { slot: slot.index });
        slot.resolveReady(slot.ready);
        this.hooks.onStarted(slot);
      })
      .catch((error: unknown) => {
        void slot.client.end("start_failed");
        const limited = RateLimited.safeParse(error);
        if (!retried && limited.success && this.hooks.running()) {
          const waitMs = Math.min(rateLimitMaxMs, limited.data.retry_after_ms ?? rateLimitMaxMs);
          record("slot_retry", { slot: slot.index, waitMs, message: String(error) });
          this.hooks.later(waitMs, () => {
            slot.client = this.newClient();
            this.listen(slot);
            this.startSlot(slot, true);
          });
          return;
        }
        slot.failed = true;
        record("slot_failed", { slot: slot.index, message: String(error) });
        slot.resolveReady(false);
        this.hooks.onStartFailed(slot, error);
      })
      .finally(() => {
        this.hooks.onStatus();
      });
  }

  /** The first slot of the pool to reach ready, or null when none does. */
  firstReady(): Promise<Slot | null> {
    return new Promise((resolve) => {
      let pending = this.slots.length;
      if (pending === 0) resolve(null);
      for (const slot of this.slots)
        void slot.readyPromise.then((ready) => {
          pending--;
          if (ready) resolve(slot);
          else if (pending === 0) resolve(null);
        });
    });
  }

  anyReady(): boolean {
    return this.slots.some((slot) => slot.ready);
  }

  /** The ready slot with the fewest builds in flight, `active` first on a tie. */
  idle(active: number): number {
    const ordered = this.slots
      .filter((slot) => slot.ready)
      .sort(
        (first, second) =>
          first.inFlight.size - second.inFlight.size ||
          Number(second.index === active) - Number(first.index === active),
      );
    return ordered[0]?.index ?? active;
  }

  /** Whether a slot still retains a built clip among its last ones, so it can be continued. */
  retains(slot: Slot, clipID: string): boolean {
    return slot.builtOrder.slice(-retainedClips).includes(clipID);
  }

  streams(): MediaStream[] {
    return this.slots.map((slot) => slot.client.stream);
  }

  views(): SlotView[] {
    return this.slots.map((slot) => ({
      index: slot.index,
      status: slot.client.status,
      trackCount: slot.client.stream.getTracks().length,
    }));
  }

  /**
   * Uploads a picture to a slot once: later calls with the same picture share the first upload.
   * Every uploaded picture is kept in the bundle under its own sequence number.
   */
  upload(slot: Slot, frame: Blob): Promise<FileRef | null> {
    const cached = slot.uploads.get(frame);
    if (cached !== undefined) return cached;
    const started = performance.now();
    const promise = slot.client
      .uploadFile(frame, "held-frame.jpg")
      .then((reference) => {
        let file = uploadedFiles.get(frame);
        if (file === undefined) {
          uploadCount++;
          file = `uploads/${String(uploadCount).padStart(4, "0")}.jpg`;
          uploadedFiles.set(frame, file);
          captureFile(file, frame);
        }
        record("uploaded", {
          slot: slot.index,
          milliseconds: Math.round(performance.now() - started),
          bytes: frame.size,
          file,
        });
        return reference;
      })
      .catch((error: unknown) => {
        record("upload_failed", { slot: slot.index, message: String(error) });
        return null;
      });
    if (slot.uploads.size > uploadCacheSize) slot.uploads.clear();
    slot.uploads.set(frame, promise);
    return promise;
  }

  /** Sends a picture to every ready slot, so a clip pinned on it never waits on an upload. */
  uploadEverywhere(frame: Blob): void {
    for (const slot of this.slots) if (slot.ready) void this.upload(slot, frame);
  }

  /**
   * Sends one clip to a slot: pinned when a picture is given, else continuing `continueFrom` when
   * that slot still retains it, else fresh. A refused continuation is retried once, pinned on the
   * fallback when given, else fresh. A slot not ready yet is waited on only briefly. Writes the
   * prompt and the full parameters to the bundle and logs `clip_queued`.
   */
  async send(slotIndex: number, request: EnqueueRequest, from: SendFrom): Promise<Sent> {
    await this.hooks.whenOpen();
    const slot = this.slots[slotIndex];
    if (slot === undefined || !this.hooks.running()) return { sent: false, reason: "ended" };
    if (
      !slot.ready &&
      !(await withDeadline("slot_ready", slotReadyMs, () => slot.readyPromise).catch(() => false))
    )
      return { sent: false, reason: "slot not ready" };
    const { inputID, guess, wanted } = from;
    let pinned = from.pinned === null ? null : await this.upload(slot, from.pinned);
    const source = from.continueFrom;
    const retained = source !== null && this.retains(slot, source);
    if (source !== null && !retained) record("source_not_retained", { sourceClipID: source });
    const promptFile = `prompts/clip-${hashText(request.prompt)}.md`;
    captureFile(promptFile, request.prompt);
    let sent: EnqueueRequest | null = null;
    const used = { continued: false };
    const attempt = async (continueFrom: string | null) => {
      if (!wanted()) {
        record("enqueue_skipped", {
          slot: slotIndex,
          inputID,
          guess,
          reason: "its round closed before it was sent",
        });
        return null;
      }
      record("enqueue", {
        slot: slotIndex,
        inputID,
        guess,
        continueFromClipID: continueFrom,
        pinned: pinned !== null,
        promptFile,
      });
      used.continued = continueFrom !== null;
      sent = {
        ...request,
        ...(pinned === null ? {} : { firstFrameImage: pinned, referenceImages: [pinned] }),
        ...(continueFrom === null
          ? {}
          : { continueFromClipID: continueFrom, continueMode: "latent" as const }),
      };
      return slot.client.enqueue(sent).catch((error: unknown) => {
        record("enqueue_failed", { slot: slotIndex, inputID, message: String(error) });
        return null;
      });
    };
    let clip = await attempt(retained && pinned === null ? source : null);
    if (clip === null && retained && pinned === null && wanted()) {
      record("retry", {
        call: "enqueue",
        inputID,
        reason: "continuation refused",
        fallback: from.fallback === null ? "fresh" : "pinned",
      });
      if (from.fallback !== null) pinned = await this.upload(slot, from.fallback);
      clip = await attempt(null);
    }
    if (clip === null && !wanted()) return { sent: false, reason: "not wanted" };
    if (clip === null) {
      record("enqueue_refused", { slot: slotIndex, inputID });
      return { sent: false, reason: "refused" };
    }
    const clipID = clip.clip_id;
    slot.inFlight.add(clipID);
    from.onQueued(clipID, pinned !== null ? "pinned" : used.continued ? "continued" : "fresh");
    const paramsFile = `clips/${clipID}.json`;
    captureFile(
      paramsFile,
      JSON.stringify(
        {
          clipID,
          slot: slotIndex,
          inputID,
          guess,
          promptFile,
          request: sent,
          pinnedFrame: from.pinned === null ? null : (uploadedFiles.get(from.pinned) ?? null),
        },
        null,
        2,
      ),
    );
    record("clip_queued", { slot: slotIndex, inputID, clipID, guess, promptFile, paramsFile });
    return { sent: true, clipID };
  }

  /**
   * Pops a clip from its slot's queues, letting the slot count it until the pop has landed; a
   * grace of 0 releases its place at once.
   */
  pop(slotIndex: number, clipID: string, graceMs: number): void {
    const owner = this.slots[slotIndex];
    if (owner === undefined) return;
    if (graceMs === 0) owner.inFlight.delete(clipID);
    else
      this.hooks.later(graceMs, () => {
        owner.inFlight.delete(clipID);
      });
    void owner.client.pop(clipID).catch((error: unknown) => {
      record("pop_failed", { clipID, message: String(error) });
    });
  }

  /** Moves a waiting clip to the front of its slot's build queue. */
  moveToFront(slotIndex: number, clipID: string): void {
    void this.slots[slotIndex]?.client.move(clipID, 0).catch((error: unknown) => {
      record("move_failed", { clipID, message: String(error) });
    });
  }

  /** Stops whatever a slot plays; a stop that loses the race to the clip's end is logged. */
  stop(slot: Slot, why: string): void {
    void slot.client.stop().catch((error: unknown) => {
      record("stop_failed", { slot: slot.index, why, message: String(error) });
    });
  }

  /** Sends every session's terminate as a request that outlives the page. */
  terminateOnUnload(): void {
    for (const slot of this.slots) slot.client.terminateOnUnload();
  }

  /** Asks every ready session for its server recording, logging each answer. */
  requestRecordings(): Promise<void>[] {
    return this.slots.map((slot) =>
      (slot.ready ? slot.client.requestRecording() : Promise.resolve(null)).then(
        (result: unknown) => {
          record("server_recording", { slot: slot.index, result });
        },
        (error: unknown) => {
          record("server_recording_failed", { slot: slot.index, message: String(error) });
        },
      ),
    );
  }

  async end(reason: string): Promise<void> {
    await Promise.all(this.slots.map((slot) => slot.client.end(reason)));
  }
}
