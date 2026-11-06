import { createStore } from "zustand/vanilla";
import {
  agentModel,
  streamLines,
  type AgentInput,
  type LinesRequest,
  type LinesTurn,
} from "../agent/index.ts";
import { boxAt, readyPresence } from "../boxes/index.ts";
import {
  bundleBuild,
  captureFile,
  mirrorRunLog,
  persistAsItGoes,
  stampBuild,
  watchRawInput,
  writeAgentReplay,
  writeSessionIndex,
  type Build,
  type RawInputLog,
} from "../capture/index.ts";
import { captureFrame, captureStill } from "../frame/index.ts";
import type { ElementBox } from "../jev/index.ts";
import {
  currentKeys,
  getJevConnection,
  getOpenAIAccess,
  getReactorAccess,
  hostedPlay,
  type Keys,
} from "../keys/index.ts";
import { phaseNames, type PhaseName } from "../liveness/index.ts";
import { agentCompactor, Memory } from "../memory/index.ts";
import { isFollow, momentKey, rootKey, type Moment, type MomentInput } from "../moments/index.ts";
import { omniDeadlines, omniModel, type OmniFactory, type OmniMessage } from "../omni/index.ts";
import { SessionPool, type Slot } from "../pool/index.ts";
import { currentRoute, type Knobs } from "../route/index.ts";
import { describeChange, openingPrompt, projectEntity, viewOf } from "../projector/index.ts";
import {
  captureConsole,
  flushNow,
  getEvents,
  getRunID,
  now,
  record,
  withDeadline,
  type RunEvent,
} from "../run-log/index.ts";
import { getScenario, scenarioFolder } from "../scenario/index.ts";
import { Recorder } from "../recording/index.ts";
import { StageBoxes } from "./stage-boxes.ts";
import { hashWorld, type ViewElement, type World } from "../state/index.ts";
import { inputLabel, inputMemory, respond } from "../turn/index.ts";
import { Ahead } from "./ahead.ts";
import { Keeper, treeHashes, type Saved } from "./keeper.ts";
import { clipLength, Clips, sendClip, type ClipOrder, type ClipRecord } from "./clips.ts";
import { FrameWatch } from "./frames.ts";
import { LocalPlayers, type LocalLoad, type Player } from "./local-players.ts";
import { InputLock } from "./lock.ts";
import { logOverlay } from "./overlay-log.ts";
import { capturePoint, seePoint } from "./point.ts";
import { initialState, viewKey, type AppState, type InputRecord, type UserInput } from "./state.ts";

export type {
  AppState,
  BakeReport,
  BakeState,
  GuessView,
  InputRecord,
  Phase,
  Progress,
  SlotView,
  UserInput,
} from "./state.ts";
export type { Knobs } from "../route/index.ts";

const idleLimitMs = 10 * 60 * 1000;
const unresolvedMs = 3000;
const blackRecordMs = 1000;
const responseFrameSeconds = [1, 3];
/**
 * How long one input may hold the lock, from its click to its answer's first frame. The opening
 * also connects a session (3.2 to 4.6 s measured) before its build; a miss runs the agent, a
 * build of 3.9 to 5.0 s and the play.
 */
const lockDeadlineMs = { start: 12000, input: 10000 } as const;
const firstFrameMs = 2500;
const reaskMs = 4000;
const localPlayersMs = 3000;
const popGraceMs = 6000;

interface Pending {
  inputID: string;
  input: AgentInput;
  midClip: boolean;
  frame: Promise<Blob | null>;
  /** The slot the frame at the click was sent to the moment it was captured, if any. */
  uploadSlot: number | null;
  /** The memory entry the input appended. */
  memoryInput: string;
}

/**
 * One running world. Composes the session pool, the moments ahead of the stage, the stage's
 * players and frame watch, and the overlay's boxes, and carries every input from its click to its
 * answer's first frame.
 */
export class Controller {
  /** What the page URL asked for when this world was opened. */
  private readonly route = currentRoute();
  readonly store = createStore<AppState>(() => initialState(getScenario(this.route.scenario)));
  /** The mechanics this session runs with, from the URL. */
  readonly knobs: Knobs = this.route.knobs;
  readonly memory = new Memory(
    agentCompactor(() => (this.keys === null ? null : getOpenAIAccess(this.keys))),
  );
  private keys: Keys | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly clips = new Clips((milliseconds, run) => {
    this.later(milliseconds, run);
  });
  private readonly pool = new SessionPool(() => getReactorAccess(this.keys), {
    running: () => this.state.phase === "running",
    whenOpen: () => this.whenResumed(),
    onStatus: () => {
      this.publishSlots();
    },
    onMessage: (slot, message) => {
      this.onOmniMessage(slot, message);
    },
    onStarted: (slot) => {
      if (slot.ready) this.preUpload(slot);
      this.ahead.pump();
    },
    onStartFailed: (slot, error) => {
      if (slot.index !== 0) return;
      this.set({ error: `Session failed: ${String(error)}` });
      void this.end("start_failed");
    },
    later: (milliseconds, run) => {
      this.later(milliseconds, run);
    },
  });
  /** Where this run's moments are kept and how far it grows: the URL's bake, or a live run. */
  private readonly keeper = new Keeper(this.route.bake, this.store.getState().scenario);
  private readonly players = new LocalPlayers({
    onStage: () => this.state.localPlayer,
    swapped: (load, previous) => {
      this.localSwapped(load, previous);
    },
    ended: (player) => {
      this.localEnded(player);
    },
    frame: (video) => {
      this.frames.frame(video);
    },
  });
  private readonly frames = new FrameWatch({
    black: (luma) => {
      this.blackFrame(luma);
    },
    firstFrame: (clipID, luma, seam) => {
      this.firstFrame(clipID, luma, seam);
    },
    changed: (clipID, difference) => {
      this.changedFrame(clipID, difference);
    },
    settled: (clipID) => {
      void this.stageBoxes.pass("playing");
      this.captureHeld(clipID);
    },
  });
  private consistent = true;
  private lastInput: AgentInput = { kind: "start" };
  private readonly ahead: Ahead = new Ahead({
    knobs: this.knobs,
    pool: this.pool,
    clips: this.clips,
    keeper: this.keeper,
    players: this.players,
    memory: this.memory,
    keys: () => this.keys,
    open: () => this.state.phase === "running" && !this.state.paused && this.consistent,
    running: () => this.state.phase === "running",
    activeSlot: () => this.state.activeSlot,
    lastInput: () => this.lastInput,
    shown: () => this.state.shownView,
    stageBoxes: () =>
      this.state.boxesKey === viewKey(this.state.shownView) &&
      this.tree.root?.state === this.state.shownView
        ? this.state.boxes
        : null,
    setGuesses: (guesses) => {
      this.set({ guesses });
    },
    linesRequest: (turn, world, signal) => this.linesRequest(turn, world, signal),
    agentLines: (request, onLine) => this.agentLines(request, onLine),
    playingNow: () => this.playingNow(),
    commitClip: (moment, clipID, inputID) => {
      this.commitClip(moment, clipID, inputID);
    },
    failAwaited: (inputID, detail) => {
      this.fail("enqueue_refused", detail, inputID);
    },
    refilmStage: (clipID, clip) => {
      void this.refilm(clipID, clip);
    },
    applyMomentBoxes: (moment) => {
      this.stageBoxes.apply(moment);
    },
  });
  private readonly stageBoxes: StageBoxes = new StageBoxes({
    clips: this.clips,
    ahead: this.ahead,
    memory: this.memory,
    state: () => this.state,
    set: (partial) => {
      this.set(partial);
    },
    frame: () => (this.video === null ? null : captureFrame(this.video)),
    keys: () => this.keys,
    committed: () => this.committedClipID,
    settled: () => this.frames.settled,
    playing: () => this.playingNow(),
    showClipState: (clipID) => {
      this.showClipState(clipID);
    },
    captureHeld: (clipID) => {
      this.captureHeld(clipID);
    },
    saveFrame: (clipID, moment, frame) => {
      this.saveFrame(clipID, moment, frame ?? null);
    },
    markInput: (clipID, partial) => {
      this.markInput(clipID, partial);
    },
    updateInput: (inputID, partial) => {
      this.updateInput(inputID, partial);
    },
    retryUnresolved: () => {
      this.retryUnresolved();
    },
    refilm: (clipID, clip) => {
      void this.refilm(clipID, clip);
    },
  });
  private committedClipID: string | null = null;
  /** The clip on stage that last reached its end or was stopped, so a follow-up may take over. */
  private endedClipID: string | null = null;
  private readonly lock = new InputLock<UserInput>((inputID, milliseconds) => {
    this.missedLock(inputID, milliseconds);
  });
  private unresolved: { event: UserInput; until: number }[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: { name: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private lastBlackRecord = 0;
  private stopMirror: (() => void) | null = null;
  private stopPersist: (() => void) | null = null;
  private stopWatching: (() => void)[] = [];
  private rawInput: RawInputLog | null = null;
  private build: Build = bundleBuild;
  private resumeWaiters: (() => void)[] = [];
  private deferredPlay: string | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private poolEnded = false;
  private anchorFrame: Blob | null = null;
  private ending: Promise<void> | null = null;
  private readonly recorder = new Recorder({
    activeVideo: () => this.video,
    activeIndex: () => this.state.activeSlot,
    streams: () => this.streams(),
  });

  /** `createClient` makes each session of the pool: live Omni, or the stand-in. */
  constructor(private readonly createClient: OmniFactory) {
    const keys = currentKeys();
    const route = this.route;
    if (keys === null || route.scenario === null || route.eval !== null || route.keys) return;
    queueMicrotask(() => {
      record("connect_at_load", {});
      this.start(keys);
    });
  }

  private get state(): AppState {
    return this.store.getState();
  }

  private set(partial: Partial<AppState>): void {
    this.store.setState(partial);
  }

  private get tree() {
    return this.ahead.tree;
  }

  /** The last frame Jev answered for, with every box it found, for the driver. */
  get lastFrame(): { base64: string; boxes: ElementBox[]; source: string } | null {
    return this.stageBoxes.lastFrame;
  }

  /** The video element on screen: the local moment player, or the active slot's. */
  get video(): HTMLVideoElement | null {
    const local = this.state.localPlayer;
    if (local !== null) return this.players.videos[local];
    return this.pool.slot(this.state.activeSlot)?.video ?? null;
  }

  /** The stream of each slot, for the stage. */
  streams(): MediaStream[] {
    return this.pool.streams();
  }

  private updateInput(inputID: string, partial: Partial<InputRecord>): void {
    this.set({
      inputs: this.state.inputs.map((input) =>
        input.inputID === inputID ? { ...input, ...partial } : input,
      ),
    });
  }

  private markInput(clipID: string, partial: Partial<InputRecord>): void {
    const input = this.state.inputs.find((candidate) => candidate.clipID === clipID);
    if (input !== undefined) this.updateInput(input.inputID, partial);
  }

  private publishSlots(): void {
    const slots = this.pool.views();
    const active = slots[this.state.activeSlot];
    this.set({
      slots,
      sessionStatus: active?.status ?? "idle",
      trackCount: active?.trackCount ?? 0,
      playingClipID: this.pool.slot(this.state.activeSlot)?.playingClipID ?? null,
    });
  }

  private later(milliseconds: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, milliseconds);
    this.timers.add(timer);
  }

  private send(order: ClipOrder) {
    return sendClip(this.pool, this.clips, () => this.state.shownView, order);
  }

  private hashes() {
    return treeHashes(
      this.state.scenario,
      this.knobs.guesses,
      this.keys === null ? "" : getJevConnection(this.keys).model,
    );
  }

  /**
   * Starts the pool and the opening at the same moment. The pool size comes from the `pool` URL
   * parameter (1 keeps the single-session path); every session starts at once, and a helper that
   * fails to start is logged and left out.
   */
  start(keys: Keys): void {
    if (this.state.phase !== "keys") return;
    this.keys = keys;
    const size = keys.hosted
      ? Math.min(this.route.pool, Math.max(1, hostedPlay()?.sessions ?? 1))
      : this.route.pool;
    record("run_start", { runID: getRunID(), scenario: this.state.scenario.id, poolSize: size });
    this.set({ phase: "running" });
    captureConsole();
    this.stopMirror = mirrorRunLog();
    const growing = this.keeper.start({
      tree: () => this.tree,
      busy: () => this.ahead.busy(),
      depths: { film: this.knobs.depth, write: this.knobs.write },
      hashes: () => this.hashes(),
      report: (bake) => {
        this.set({ bake });
      },
    });
    if (!growing) return;
    void stampBuild().then((build) => {
      this.build = build;
      this.writeIndex(null);
    });
    this.stopPersist = persistAsItGoes(
      () => this.state.phase === "running",
      () => {
        this.writeIndex(null);
        writeAgentReplay();
      },
    );
    this.stopWatching.push(logOverlay(this.store));
    const rawInput = watchRawInput({
      videoRect: () => this.video?.getBoundingClientRect() ?? null,
      locked: () => this.state.locked,
    });
    this.rawInput = rawInput;
    this.stopWatching.push(rawInput.stop);
    this.writeIndex(null);
    this.pool.open(size, this.createClient);
    this.publishSlots();
    this.watchTracks();
    const unload = (reason: string) => {
      this.pool.terminateOnUnload();
      void this.end(reason);
    };
    window.addEventListener("pagehide", () => {
      unload("pagehide");
    });
    window.addEventListener("beforeunload", () => {
      unload("beforeunload");
    });
    void this.keeper.load(this.hashes()).then((saved) => {
      if (this.state.phase !== "running") return;
      this.open(saved);
    });
  }

  /**
   * Films the scenario's fixed opening on the first ready slot, with no agent call in the way, while
   * the agent guesses the first inputs in parallel. Helpers film guesses only from a frame held in
   * this session, never from a picture kept from an earlier one.
   */
  private open(saved: Saved | null): void {
    const pending = this.newInput({ kind: "start" }, "start", false);
    if (saved !== null && saved.check.moments[0]?.record.status === "ready") {
      void this.openSaved(pending, saved);
      return;
    }
    const state = this.state.view;
    const scenario = this.state.scenario;
    const opening = openingPrompt(scenario.world);
    const root = this.ahead.moment({
      key: rootKey(scenario.premise, JSON.stringify(scenario.world), opening),
      parentKey: null,
      input: null,
      index: 0,
      label: "start",
      lines: [],
      ops: [],
      world: scenario.world,
      state,
      beat: null,
      likelihood: null,
      memory: { input: "start", response: "" },
      prompt: opening,
    });
    root.status = "filming";
    this.ahead.plant(root);
    this.set({ busy: true });
    record("state_hash", { inputID: pending.inputID, hash: hashWorld(state.world) });
    void (async () => {
      const slot = await this.pool.firstReady();
      if (slot === null) return;
      root.slot = slot.index;
      this.set({ activeSlot: slot.index });
      record("opening_slot", { slot: slot.index });
      this.updateInput(pending.inputID, { enqueuedAt: now() });
      const sent = await this.send({
        slot: slot.index,
        request: { prompt: opening, seconds: clipLength, metadata: pending.inputID, position: 0 },
        moment: root,
        stateOf: () => state,
        inputID: pending.inputID,
      });
      if (!sent.sent) {
        this.fail("enqueue_refused", `the opening was not sent: ${sent.reason}`, pending.inputID);
        return;
      }
      this.updateInput(pending.inputID, { queuedAt: now(), clipID: sent.clipID });
      this.progress(pending.inputID, "filming");
      root.clipID = sent.clipID;
      this.committedClipID = sent.clipID;
      this.showWhenBuilt(sent.clipID);
      this.ahead.pump();
    })();
    this.ahead.writeGuesses(root, { kind: "start" }, pending.inputID, this.ahead.ask(root));
  }

  /**
   * Opens on a saved tree: every moment that still holds is planted with its replayed world, its
   * filmed ones complete with their local media, held frames and boxes, and the opening plays from
   * local media at once while the pool connects. Its clips are given ids of their own and no
   * session, so nothing ever continues from them; children film pinned on their held frames.
   */
  private async openSaved(pending: Pending, baked: Saved): Promise<void> {
    const source = this.state.scenario.moments;
    for (const loaded of baked.check.moments) {
      const saved = loaded.record;
      const moment = this.ahead.moment({
        key: saved.key,
        parentKey: saved.parentKey,
        input: saved.input,
        index: saved.index,
        label: saved.label,
        lines: saved.lines,
        ops: loaded.ops,
        world: loaded.world,
        state: loaded.state,
        beat: saved.beat,
        likelihood: saved.likelihood,
        memory: saved.memory,
        prompt: saved.prompt,
      });
      moment.baked = true;
      moment.start = saved.start;
      const url = saved.clip === null ? null : (source?.mediaURL(saved.clip) ?? null);
      const held = saved.parentKey === null ? await baked.held(saved.key) : null;
      if (saved.status === "ready" && url !== null && (held !== null || saved.parentKey !== null)) {
        const clipID = `baked-${saved.key}`;
        moment.status = "ready";
        moment.clipURL = url;
        moment.held = held;
        if (saved.parentKey !== null)
          this.heldLater(moment, baked.held(saved.key), baked.check.rebox);
        moment.boxes = saved.boxes;
        moment.checks = saved.checks;
        moment.clipID = clipID;
        this.clips.local(clipID, moment);
      }
      if (saved.parentKey === null) this.ahead.plant(moment);
      else this.tree.add(moment);
    }
    for (const moment of this.tree.all())
      moment.children = this.tree.children(moment).length > 0 ? "written" : "none";
    if (baked.check.rebox)
      for (const moment of this.tree.all())
        if (moment.status === "ready" && moment.held !== null) this.ahead.rebox(moment);
    const root = this.tree.root;
    const clipID = root?.clipID ?? null;
    if (root === null || clipID === null) return;
    record("baked_opening", {
      key: root.key,
      moments: this.tree.all().length,
      filmed: this.tree.all().filter((moment) => moment.status === "ready").length,
      stale: baked.check.stale.length,
      behind: baked.check.behind,
    });
    record("state_hash", { inputID: pending.inputID, hash: hashWorld(root.world) });
    this.set({ busy: true, view: root.state });
    await withDeadline("local_players", localPlayersMs, () => this.players.attached).catch(
      () => undefined,
    );
    this.updateInput(pending.inputID, { enqueuedAt: now() });
    this.playMoment(root, clipID, pending.inputID);
    this.ahead.publish();
    this.ahead.pump();
  }

  /**
   * Gives a saved moment its held frame when the fetch lands: its children can then be pinned on
   * it, and it is boxed again when the saved tree was boxed by another Jev model. One that never
   * lands goes back to written unless it is already on stage.
   */
  private heldLater(moment: Moment, held: Promise<Blob | null>, rebox: boolean): void {
    void held.then((frame) => {
      if (!this.tree.holds(moment) || moment.held !== null) return;
      if (frame !== null) {
        moment.held = frame;
        if (rebox) this.ahead.rebox(moment);
        this.ahead.pump();
        return;
      }
      if (this.tree.root === moment) return;
      moment.status = "written";
      moment.clipURL = null;
      moment.clipID = null;
      moment.boxes = null;
      moment.checks = null;
      this.ahead.publish();
      this.ahead.pump();
    });
  }

  /**
   * Sends a session that just became ready the held frames it is likeliest to pin on (the moment
   * on screen and its guesses), so its first film never waits on an upload.
   */
  private preUpload(slot: Slot): void {
    const root = this.tree.root;
    const frames = (root === null ? [] : [root, ...this.tree.children(root)]).flatMap((moment) =>
      moment.held === null ? [] : [moment.held],
    );
    if (frames.length > 0) record("pre_upload", { slot: slot.index, frames: frames.length });
    for (const image of frames) void this.pool.upload(slot, image);
  }

  private watchTracks(): void {
    const check = () => {
      const counts = this.pool.all.map((slot) => slot.client.stream.getTracks().length);
      if ((counts[0] ?? 0) > 0 && this.state.phase === "running") this.recorder.start();
      if (counts.some((count, index) => count !== this.state.slots[index]?.trackCount))
        this.publishSlots();
      if (this.state.phase === "running") setTimeout(check, 250);
    };
    check();
  }

  /** Saves a still of the video on screen as a bundle file next to the Jev frames. */
  private saveFrame(clipID: string, moment: string, frame: Blob | null = null): void {
    const video = this.video;
    const still =
      frame !== null
        ? Promise.resolve(frame)
        : video === null
          ? Promise.resolve(null)
          : captureStill(video);
    void still.then((image) => {
      if (image === null) return;
      const file = `frames/${clipID.slice(0, 8)}-${moment}.jpg`;
      captureFile(file, image);
      record("frame_saved", { clipID, moment, file, playingClipID: this.state.playingClipID });
    });
  }

  /** Attaches a slot's video element and starts watching its frames. */
  attachVideo(slotIndex: number, video: HTMLVideoElement | null): void {
    const slot = this.pool.slot(slotIndex);
    if (slot === undefined || video === null || slot.video === video) return;
    slot.video = video;
    const onFrame = () => {
      if (slot.index === this.state.activeSlot && this.state.localPlayer === null)
        this.frames.frame(video);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  /** Attaches one of the two local moment players and starts watching its frames. */
  attachLocal(player: Player, video: HTMLVideoElement | null): void {
    this.players.attach(player, video);
  }

  /**
   * A local load painted its first frame and took the stage: any session still playing on stage
   * stops so its next clip never plays over local media.
   */
  private localSwapped(load: LocalLoad, previous: Player | null): void {
    const live = this.pool.slot(this.state.activeSlot);
    if (previous === null && live?.playingClipID != null) this.pool.stop(live, "local_on_stage");
    this.set({ localPlayer: load.player });
    if (load.play) this.stageBoxes.apply(load.moment);
    this.publishSlots();
    this.ahead.warmLikeliest();
  }

  /** A local clip ended on stage: its held frame is on stage now, already boxed. */
  private localEnded(player: Player): void {
    const moment = this.players.moments[player];
    if (moment === null || this.tree.root !== moment) return;
    record("clip_finished", { slot: null, clipID: moment.clipID, local: true });
    this.set({ playing: this.pool.all.some((slot) => slot.playingClipID !== null) });
    this.endedClipID = moment.clipID;
    if (this.continueChain()) return;
    void this.stageBoxes.hold(moment);
  }

  private blackFrame(luma: number): void {
    if (this.clips.size === 0 || this.state.phase !== "running") return;
    this.set({ blackFrames: this.state.blackFrames + 1 });
    if (performance.now() - this.lastBlackRecord <= blackRecordMs) return;
    this.lastBlackRecord = performance.now();
    record("black_frame", { luma, playingClipID: this.state.playingClipID });
  }

  private firstFrame(clipID: string, luma: number, seam: number | null): void {
    this.clearWatchdog("first_frame");
    record("first_frame", {
      clipID,
      luma,
      seam,
      local: this.state.localPlayer !== null,
      start: this.clips.get(clipID)?.moment?.start ?? null,
    });
    const answered = this.state.inputs.find((item) => item.clipID === clipID);
    if (answered !== undefined) this.progress(answered.inputID, "arriving");
    if (answered !== undefined && answered.inputID === this.state.locked) this.unlock("answered");
    this.markInput(clipID, { firstFrameAt: now() });
    this.set({ firstFrames: this.state.firstFrames + 1, playing: true });
  }

  private changedFrame(clipID: string, difference: number): void {
    record("first_changed_frame", { clipID, difference });
    this.showClipState(clipID);
    const input = this.state.inputs.find((item) => item.clipID === clipID);
    if (input !== undefined)
      record("response", {
        inputID: input.inputID,
        clipID,
        outcome: input.outcome,
        midClip: input.midClip,
        firstFrameSeconds: input.firstFrameAt === null ? null : input.firstFrameAt - input.t,
        firstChangedFrameSeconds: now() - input.t,
      });
  }

  /**
   * The picture of a clip has changed: the shown state becomes that clip's state, and boxes found
   * for any other state are dropped.
   */
  private showClipState(clipID: string): void {
    const clip = this.clips.get(clipID);
    if (clip === undefined) return;
    const shown = clip.stateOf();
    this.frames.markChanged(clipID);
    if (shown === this.state.shownView) return;
    const key = viewKey(shown);
    record("shown_state", { clipID, key });
    this.set({ shownView: shown });
    if (this.state.boxesKey !== key) {
      if (this.state.boxes.length > 0) record("boxes_invalidated", { clipID });
      this.set({ boxes: [], boxesKey: null });
    }
  }

  /** Captures the settled frame of the moment on screen once, so its guesses can be pinned on it. */
  private captureHeld(clipID: string): void {
    const video = this.video;
    const root = this.tree.root;
    if (video === null || root?.clipID !== clipID || root.held !== null) return;
    void captureStill(video).then((frame) => {
      if (frame === null || !this.tree.holds(root) || root.clipID !== clipID || root.held !== null)
        return;
      root.held = frame;
      record("held_frame_captured", { clipID, bytes: frame.size });
      this.saveFrame(clipID, "settled", frame);
      this.ahead.pump();
    });
  }

  /**
   * Moves an input's progress forward, logging a `phase` event, and once a beat line is known a
   * `beat` event. Progress only ever moves forward, and only for the latest input.
   */
  private progress(inputID: string, phase: PhaseName, beat: string | null = null): void {
    const order = phaseNames;
    const current = this.state.progress;
    const same = current?.inputID === inputID;
    if (!same && this.state.inputs.at(-1)?.inputID !== inputID) return;
    if (same && order.indexOf(phase) <= order.indexOf(current.phase) && beat === null) return;
    const known = same ? current.beat : null;
    if (beat !== null && known === null) record("beat", { inputID, text: beat });
    const next =
      same && order.indexOf(phase) < order.indexOf(current.phase) ? current.phase : phase;
    const moved = !same || next !== current.phase;
    if (moved) record("phase", { inputID, phase: next });
    const since = moved ? now() : current.since;
    this.set({ progress: { inputID, phase: next, beat: known ?? beat, since } });
  }

  /**
   * The one way input enters: the overlay and any driver both call this. A click names a box by
   * element id or gives a point as fractions of the frame, hit-tested against the current boxes.
   * Once an input is accepted it holds the lock until its answer's first frame plays, because an
   * answer cannot be cancelled, or until the lock's deadline from the click passes, which fails
   * it. The store's `locked` names the input being answered. An input arriving during the lock is
   * kept as `input_buffered`, only the last one, as the element it was aimed at on the stage then,
   * and replayed the moment the lock lifts. A click only lands on boxes found for the view on
   * stage; one that finds none waits briefly for the next boxes.
   */
  input(event: UserInput): void {
    const pointerID = this.rawInput?.link() ?? null;
    const before = getEvents().length;
    try {
      this.take(event);
    } finally {
      if (pointerID !== null)
        record("pointer_outcome", {
          pointerID,
          outcome:
            getEvents()
              .slice(before)
              .map((item) => item.kind)
              .filter((kind) => kind.startsWith("input") || kind.startsWith("speculation_"))
              .join(",") || "dropped",
        });
    }
  }

  private take(event: UserInput): void {
    if (this.state.phase !== "running") return;
    if (this.state.paused) {
      record("input_paused", { event });
      return;
    }
    const locked = this.state.locked;
    if (locked !== null || !this.consistent) {
      const aimed = this.findElement(event);
      const kept: UserInput =
        event.kind === "click" && "x" in event && aimed !== null
          ? { kind: "click", elementID: aimed.id }
          : event;
      const replaced = this.lock.hold(kept);
      record("input_buffered", { event, kept, lockedBy: locked });
      if (replaced !== null) record("input_superseded", { event: replaced, by: kept });
      return;
    }
    const midClipNow = this.playingNow();
    if (event.kind === "instruct") {
      const text = event.text.trim();
      if (text === "") return;
      const instruction: AgentInput = { kind: "instruct", text };
      this.miss(instruction, this.newInput(instruction, "miss", midClipNow, event, null));
      return;
    }
    const element = this.findElement(event);
    if (element === null) {
      if (
        event.kind === "click" &&
        "x" in event &&
        this.state.boxesKey === viewKey(this.state.shownView)
      ) {
        this.pointClick(event, midClipNow);
        return;
      }
      if (event.kind === "click" && this.unresolved.length < 3) {
        this.unresolved.push({ event, until: performance.now() + unresolvedMs });
        record("input_waiting_for_boxes", { event });
        this.later(unresolvedMs + 1, () => {
          this.retryUnresolved();
        });
      } else record("input_ignored", { event, reason: "no element there" });
      return;
    }
    const input: AgentInput =
      event.kind === "type"
        ? { kind: "type", elementID: element.id, label: element.label, text: event.text }
        : { kind: "click", elementID: element.id, label: element.label };
    const midClip = this.playingNow();
    const key: MomentInput = {
      elementID: element.id,
      action: input.kind === "type" ? "type" : "click",
      text: input.kind === "type" ? input.text : null,
    };
    const match = this.tree.root?.state === this.state.view ? this.tree.findMatch(key) : null;
    const box = this.state.boxes.find((found) => found.elementID === element.id) ?? null;
    const local =
      match !== null &&
      match.clipURL !== null &&
      (match.status === "ready" || match.status === "captured");
    const known = local && !midClip ? (this.tree.root?.held ?? null) : null;
    if (match !== null) this.hit(match, this.newInput(input, "hit", midClip, event, box, known));
    else this.miss(input, this.newInput(input, "miss", midClip, event, box));
  }

  private retryUnresolved(): void {
    const waiting = this.unresolved;
    this.unresolved = [];
    for (const item of waiting) {
      if (performance.now() > item.until) {
        record("input_ignored", { event: item.event, reason: "no element there within the wait" });
        continue;
      }
      if (this.findElement(item.event) === null) this.unresolved.push(item);
      else this.input(item.event);
    }
  }

  /**
   * A click that lands on no box still counts: input locks at once with its deadline from the
   * click, the frame and a crop around the point are taken from the video, and Jev says which
   * thing in the world is there, or open background, within its deadline. The agent then answers
   * a click on that thing at that spot as a miss, adding it as its own pick. A point Jev cannot
   * answer unlocks and is dropped.
   */
  private pointClick(point: { x: number; y: number }, midClip: boolean): void {
    const video = this.video;
    const keys = this.keys;
    const pictures = video === null ? null : capturePoint(video, point);
    if (video === null || keys === null || pictures === null) {
      record("input_ignored", { event: { kind: "click", ...point }, reason: "no frame to read" });
      return;
    }
    const inputID = crypto.randomUUID().slice(0, 8);
    const t = now();
    const frame = captureStill(video);
    const world = this.state.shownView.world;
    this.lock.lock(inputID, lockDeadlineMs.input);
    if (this.state.paused) this.lock.suspend();
    this.set({ locked: inputID });
    record("point_asked", { inputID, ...point, midClip });
    void seePoint(getJevConnection(keys), pictures, point, world, inputID).then((input) => {
      if (this.state.phase !== "running" || this.state.locked !== inputID) return;
      if (input === null) {
        this.unlock("point_unseen");
        this.stageBoxes.reopen("point_unseen");
        return;
      }
      const event: UserInput = { kind: "click", ...point };
      this.miss(
        input,
        this.newInput(input, "miss", midClip, event, null, null, { inputID, t, frame }),
      );
    });
  }

  private findElement(event: UserInput): ViewElement | null {
    if (event.kind === "instruct") return null;
    const elements = this.state.shownView.elements;
    const current = this.state.boxesKey === viewKey(this.state.shownView);
    if ("elementID" in event) {
      if (
        event.kind === "click" &&
        !(current && this.state.boxes.some((found) => found.elementID === event.elementID))
      )
        return null;
      return elements.find((element) => element.id === event.elementID) ?? null;
    }
    if (!current) return null;
    const hit = boxAt(
      this.state.boxes.filter((found) => found.presence >= readyPresence),
      event,
    );
    return hit === null ? null : (elements.find((element) => element.id === hit.elementID) ?? null);
  }

  private newInput(
    input: AgentInput,
    outcome: InputRecord["outcome"],
    midClip: boolean,
    event: UserInput | null = null,
    box: ElementBox | null = null,
    knownFrame: Blob | null = null,
    clicked: { inputID: string; t: number; frame: Promise<Blob | null> } | null = null,
  ): Pending {
    this.resetIdleTimer();
    this.recorder.resume();
    const inputID = clicked?.inputID ?? crypto.randomUUID().slice(0, 8);
    this.lastInput = input;
    if (clicked === null) {
      this.lock.lock(inputID, input.kind === "start" ? lockDeadlineMs.start : lockDeadlineMs.input);
      if (this.state.paused) this.lock.suspend();
      this.set({ locked: inputID });
    }
    const t = clicked?.t ?? now();
    record("input", {
      inputID,
      input,
      outcome,
      midClip,
      event,
      box,
      clipOnStage: this.state.playingClipID ?? this.committedClipID,
      frame: input.kind === "start" ? null : `inputs/${inputID}.jpg`,
    });
    const memoryInput = inputMemory(input);
    this.memory.append({
      t,
      kind: input.kind === "instruct" || input.kind === "type" ? "direction" : "input",
      text: memoryInput,
    });
    this.set({
      inputs: [
        ...this.state.inputs,
        {
          inputID,
          t,
          kind: input.kind,
          label: inputLabel(input),
          outcome,
          midClip,
          enqueuedAt: null,
          queuedAt: null,
          firstFrameAt: null,
          boxesAt: null,
          clipID: null,
          failed: null,
          source: null,
          again:
            input.kind === "start"
              ? null
              : input.kind === "click"
                ? { kind: "click", elementID: input.elementID }
                : input.kind === "point"
                  ? { kind: "click", x: input.x, y: input.y }
                  : input.kind === "type"
                    ? { kind: "type", elementID: input.elementID, text: input.text }
                    : input,
          box,
          prompt: null,
        },
      ],
    });
    const video = this.video;
    const frame =
      clicked !== null
        ? clicked.frame
        : knownFrame !== null
          ? Promise.resolve(knownFrame)
          : video === null || input.kind === "start"
            ? Promise.resolve(null)
            : captureStill(video);
    const uploadSlot =
      input.kind === "start" || knownFrame !== null || !this.pool.anyReady()
        ? null
        : this.pool.idle(this.state.activeSlot);
    void frame.then((still) => {
      if (still === null) return;
      captureFile(`inputs/${inputID}.jpg`, still);
      const slot = uploadSlot === null ? undefined : this.pool.slot(uploadSlot);
      if (slot === undefined) return;
      record("upload_at_click", { inputID, slot: slot.index });
      void this.pool.upload(slot, still);
    });
    return { inputID, input, midClip, frame, uploadSlot, memoryInput };
  }

  /** The slot a pinned answer goes to: the one its click frame went to while still ready. */
  private pinSlot(uploadSlot: number | null): number {
    return uploadSlot !== null && this.pool.slot(uploadSlot)?.ready === true
      ? uploadSlot
      : this.pool.idle(this.state.activeSlot);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.end("idle_limit"), idleLimitMs);
  }

  /** Whether a clip is playing on stage now, live from a session or from local media. */
  private playingNow(): boolean {
    return this.state.playingClipID !== null || this.players.playing();
  }

  /**
   * A guessed moment was chosen: it becomes the root and everything outside it is dropped. A clip
   * already sent plays the moment it is built; one still being sent plays once it lands; one
   * never sent, or rejected, is filmed at once pinned on the frame at the click.
   */
  private hit(moment: Moment, pending: Pending): void {
    const parent = moment.parentKey === null ? null : this.tree.get(moment.parentKey);
    record("speculation_hit", {
      inputID: pending.inputID,
      elementID: moment.input?.elementID ?? null,
      clipID: moment.clipID,
      slot: moment.slot,
      status: moment.status,
      likelihood: moment.likelihood,
    });
    this.ahead.reRoot(moment, "round_closed");
    this.set({ view: moment.state, heldReady: false });
    record("state_snapshot", { inputID: pending.inputID, state: moment.state });
    record("state_hash", { inputID: pending.inputID, hash: hashWorld(moment.world) });
    this.memory.append({ t: now(), kind: "response", text: moment.memory.response });
    this.progress(pending.inputID, "filming", moment.beat ?? moment.label);
    this.updateInput(pending.inputID, { enqueuedAt: now() });
    const clipID = moment.clipID;
    const local =
      clipID !== null &&
      moment.clipURL !== null &&
      (moment.status === "captured" || moment.status === "ready");
    if (local) this.playMoment(moment, clipID, pending.inputID);
    else if (clipID !== null && moment.status !== "rejected")
      this.commitClip(moment, clipID, pending.inputID);
    else if (moment.status === "filming") this.ahead.await(moment, pending.inputID);
    else {
      record("speculation_hit_unqueued", { inputID: pending.inputID, status: moment.status });
      this.ahead.await(moment, pending.inputID);
      if (clipID !== null) this.ahead.popClip(clipID, moment, "refilm");
      moment.clipID = null;
      void pending.frame.then((frame) => {
        if (!this.tree.holds(moment) || moment.status === "filming") return;
        const parentHeld = parent?.held ?? frame;
        const slot = this.pinSlot(pending.uploadSlot);
        record("speculation_hit_pinned", { inputID: pending.inputID, slot });
        void this.ahead.film(moment, slot, parentHeld === null ? "fresh" : "pinned", {
          pinned: parentHeld,
          position: 0,
        });
      });
    }
    this.ahead.publish();
    this.ahead.pump();
  }

  /** The input's answer is this clip: the lock waits on it, and it plays the moment it is built. */
  private commitClip(moment: Moment, clipID: string, inputID: string): void {
    this.ahead.settleAwaited(moment);
    this.committedClipID = clipID;
    this.updateInput(inputID, { clipID, queuedAt: now(), source: "live" });
    this.showWhenBuilt(clipID);
  }

  /**
   * The input's answer is a captured moment: it plays from local media at once, with no network
   * in the way; the lock lifts at its first painted frame, its stored boxes apply then, and its
   * clip, built and never to be played live, is popped from its session.
   */
  private playMoment(moment: Moment, clipID: string, inputID: string | null): void {
    this.committedClipID = clipID;
    if (inputID !== null) this.updateInput(inputID, { clipID, queuedAt: now(), source: "local" });
    this.ahead.popClip(clipID, moment, "played_locally");
    const clip = this.clips.get(clipID);
    if (clip !== undefined) clip.played = true;
    this.frames.holdReference(this.video);
    this.frames.await(clipID);
    this.frames.settle(null);
    this.stageBoxes.stopSampling();
    this.stageBoxes.invalidate();
    this.set({ boxesSource: null, heldReady: false, busy: false });
    if (!this.players.show(moment, true)) {
      this.fail("local_play_failed", "no local player for a captured moment", inputID);
      return;
    }
    this.startWatchdog("first_frame", firstFrameMs, () => {
      if (!this.frames.awaitingFirstFrame(clipID)) return;
      this.fail("first_frame_stall", `no local frame within ${firstFrameMs} ms`, inputID);
    });
  }

  /**
   * Plays a committed clip the moment it is built, moving it to the front of its slot's queue and
   * watching its build: a build that misses its deadline fails the input waiting on it.
   */
  private showWhenBuilt(clipID: string): void {
    const clip = this.clips.get(clipID);
    if (clip?.built === true) {
      this.playNow(clipID);
      return;
    }
    const slotIndex = clip?.slot ?? 0;
    const slot = this.pool.slot(slotIndex);
    const waitingSince = now();
    const inputID = this.state.locked;
    record("waiting_on_build", { clipID, inputID });
    this.startWatchdog("build", omniDeadlines.build, () => {
      if (this.committedClipID !== clipID) return;
      const detail = `no clip_generated within ${omniDeadlines.build} ms`;
      if (inputID === null) {
        record("build_stall", { clipID, inputID, detail });
        return;
      }
      this.fail("build_stall", detail, inputID);
    });
    if (slot !== undefined && [...slot.inFlight][0] !== clipID)
      this.pool.moveToFront(slotIndex, clipID);
    this.clips.whenBuilt(clipID, () => {
      record("build_waited", {
        clipID,
        waitSeconds: Math.round((now() - waitingSince) * 1000) / 1000,
      });
      if (this.committedClipID === clipID) this.playNow(clipID);
    });
  }

  private linesRequest(turn: LinesTurn, world: World, signal: AbortSignal): LinesRequest | null {
    const keys = this.keys;
    if (keys === null) return null;
    return {
      openAI: getOpenAIAccess(keys),
      premise: this.state.scenario.premise,
      world,
      memory: this.memory.context(),
      turn,
      guesses: this.knobs.guesses,
      cacheKey: `vibe-ui-${getRunID()}`,
      signal,
      ...(this.knobs.model === null && this.knobs.effort === "none"
        ? {}
        : { model: { name: this.knobs.model ?? agentModel, effort: this.knobs.effort } }),
    };
  }

  /**
   * Answers an input nobody guessed: the agent writes the change from the world as it is, the
   * clip is projected and sent the moment the change settles, and the guesses that follow become
   * the answer's children. Input stays locked and inconsistent until the change settles.
   */
  private miss(input: AgentInput, pending: Pending): void {
    const parent = this.tree.root;
    if (input.kind !== "start")
      record("speculation_miss", {
        inputID: pending.inputID,
        guesses: (parent === null ? [] : this.tree.children(parent)).map(
          (child) => child.input?.elementID ?? null,
        ),
      });
    this.ahead.dropGuesses("round_closed");
    const beforeWorld = this.state.view.world;
    this.consistent = false;
    this.set({ busy: true, heldReady: false });
    const sourceClipID = this.committedClipID;
    const abort = new AbortController();
    if (parent !== null) this.ahead.startWriting(parent, abort);
    let answered: Moment | null = null;
    this.progress(pending.inputID, "thinking");
    respond(input, {
      inputID: pending.inputID,
      world: beforeWorld,
      reask: this.knobs.reask,
      reaskMs,
      signal: abort.signal,
      stream: (problems, signal, onLine) => {
        const request = this.linesRequest(
          { kind: "respond", input, problems },
          beforeWorld,
          signal,
        );
        return request === null ? null : this.agentLines(request, onLine);
      },
      onProgress: (beat) => {
        this.progress(pending.inputID, "writing", beat);
      },
      onCommit: (draft, stats, continues) => {
        const after = viewOf(draft.world);
        if (parent === null || !this.tree.holds(parent) || abort.signal.aborted) return null;
        const answerInput: MomentInput =
          input.kind === "type"
            ? { elementID: input.elementID, action: "type", text: input.text }
            : input.kind === "click"
              ? { elementID: input.elementID, action: "click", text: null }
              : input.kind === "point"
                ? { elementID: input.thingID ?? "", action: "click", text: null }
                : input.kind === "instruct"
                  ? { elementID: "", action: "type", text: input.text }
                  : { elementID: "", action: "click", text: null };
        const answer = this.ahead.moment({
          key: momentKey(parent.key, answerInput, draft.lines),
          parentKey: parent.key,
          input: answerInput,
          index: 0,
          label: inputLabel(input),
          lines: draft.lines,
          ops: draft.ops,
          world: draft.world,
          state: after,
          beat: describeChange(beforeWorld, draft.world, draft.ops),
          likelihood: null,
          memory: { input: pending.memoryInput, response: draft.lines.join("; ") },
          prompt: "",
        });
        this.ahead.handOff(parent, answer, abort);
        answered = answer;
        const guesses = this.ahead.guessesFor(answer, this.knobs.guesses, true);
        this.set({ view: after });
        record("turn_ready", {
          inputID: pending.inputID,
          projector: "entity",
          readyMs: stats.readyMs,
          readyChars: draft.lines.join("\n").length,
          lines: draft.lines.length,
          skipped: draft.skipped.length,
        });
        record("turn_valid", {
          inputID: pending.inputID,
          projector: "entity",
          valid: stats.rejected === 0 && !stats.reasked,
          rejectedLines: stats.rejected,
          reasked: stats.reasked,
        });
        record("patch_applied", {
          inputID: pending.inputID,
          elements: after.elements.map((element) => element.id),
        });
        record("state_hash", { inputID: pending.inputID, hash: hashWorld(draft.world) });
        record("state_snapshot", { inputID: pending.inputID, state: after });
        this.memory.append({ t: now(), kind: "response", text: draft.lines.join("; ") });
        try {
          answer.prompt = projectEntity(
            draft.world,
            input,
            beforeWorld,
            draft.ops,
            !continues,
          ).prompt;
          void this.sendAnswer(pending, answer, sourceClipID, pending.midClip ? null : parent.held);
        } catch (error: unknown) {
          this.fail("projection_failed", String(error), pending.inputID);
        }
        this.becomeConsistent();
        return guesses;
      },
      onWritten: () => {
        if (answered !== null) this.ahead.finishWriting(abort);
      },
      onFail: (detail, refused) => {
        this.fail(refused ? "agent_refused" : "agent_failed", detail, pending.inputID);
        if (parent !== null) this.ahead.abandonWriting(abort);
        this.becomeConsistent();
      },
    });
  }

  private becomeConsistent(): void {
    if (this.consistent) return;
    this.consistent = true;
    queueMicrotask(() => {
      this.replayHeld();
    });
  }

  /**
   * Replays the input kept during the lock, once input is open again: unlocked, consistent,
   * running and not paused.
   */
  private replayHeld(): void {
    if (
      this.state.phase !== "running" ||
      this.state.paused ||
      this.state.locked !== null ||
      !this.consistent
    )
      return;
    const held = this.lock.takeHeld();
    if (held === null) return;
    record("input_replayed", { event: held });
    this.input(held);
  }

  /**
   * Where an answer clip goes. When the clip it follows is built, nothing plays and its slot has
   * no build running, it continues from that clip; otherwise it never waits: it starts from the
   * frame on screen at the input, on an idle slot, the active one first.
   */
  private answerTarget(
    sourceClipID: string | null,
    frame: Blob | null,
    uploadSlot: number | null,
  ): { slot: number; continueFrom: string | null; pinned: Blob | null } {
    const source = sourceClipID === null ? undefined : this.clips.get(sourceClipID);
    const sourceSlot = this.pool.slot(source?.slot ?? this.state.activeSlot);
    const playing = this.playingNow();
    if (
      sourceSlot !== undefined &&
      (frame === null ||
        (source?.built === true && !source.popped && !playing && sourceSlot.inFlight.size === 0) ||
        sourceClipID === null)
    )
      return { slot: sourceSlot.index, continueFrom: sourceClipID, pinned: null };
    return { slot: this.pinSlot(uploadSlot), continueFrom: null, pinned: frame };
  }

  private async sendAnswer(
    pending: Pending,
    answer: Moment,
    sourceClipID: string | null,
    held: Blob | null,
  ): Promise<void> {
    if (this.state.phase !== "running") return;
    const target = this.answerTarget(
      sourceClipID,
      held ?? (await pending.frame),
      held === null ? pending.uploadSlot : null,
    );
    record("response_target", {
      inputID: pending.inputID,
      slot: target.slot,
      continueFrom: target.continueFrom,
      pinned: target.pinned !== null,
    });
    const go = async (continueFrom: string | null) => {
      this.updateInput(pending.inputID, { enqueuedAt: now(), prompt: answer.prompt });
      answer.slot = target.slot;
      answer.start = continueFrom !== null ? "latent" : target.pinned !== null ? "pinned" : "fresh";
      const sent = await this.send({
        slot: target.slot,
        request: {
          prompt: answer.prompt,
          seconds: clipLength,
          metadata: pending.inputID,
          position: 0,
        },
        moment: answer,
        stateOf: () => answer.state,
        inputID: pending.inputID,
        continueFrom,
        pinned: target.pinned,
      });
      if (!sent.sent) {
        answer.status = "rejected";
        this.fail("enqueue_refused", `the clip was not sent: ${sent.reason}`, pending.inputID);
        return;
      }
      this.progress(pending.inputID, "filming");
      answer.clipID = sent.clipID;
      this.commitClip(answer, sent.clipID, pending.inputID);
      this.ahead.publish();
      this.ahead.pump();
    };
    const continueFrom = target.continueFrom;
    if (continueFrom === null || this.clips.get(continueFrom)?.built !== false)
      await go(continueFrom);
    else
      this.clips.whenBuilt(continueFrom, () => void go(continueFrom), {
        milliseconds: omniDeadlines.build,
        onMiss: () => void go(null),
      });
  }

  /**
   * Hands the stage to the follow-up of the moment on stage once that moment's clip has ended,
   * while no input is being answered and the session runs: it becomes the moment on stage and plays
   * from local media when captured, else live the moment it is built. One still building takes
   * over when its build lands, the held frame on stage meanwhile with input open as after any
   * clip. Any input cuts the chain, since it drops every follow-up from the tree. Returns whether
   * one took over.
   */
  private continueChain(): boolean {
    const root = this.tree.root;
    const state = this.state;
    if (root?.clipID == null || root.clipID !== this.endedClipID) return false;
    if (state.phase !== "running" || state.paused || state.locked !== null || !this.consistent)
      return false;
    const follow = this.ahead.followOf(root);
    const clipID = follow?.clipID ?? null;
    if (follow === null || clipID === null || follow.status === "rejected") return false;
    const clip = this.clips.get(clipID);
    const local =
      follow.clipURL !== null && (follow.status === "captured" || follow.status === "ready");
    if (!local && (clip?.built !== true || clip.popped)) return false;
    record("follow_on_stage", { key: follow.key, clipID, from: root.clipID, local });
    this.ahead.reRoot(follow, "follow_up");
    this.set({ view: follow.state, heldReady: false });
    record("state_hash", { inputID: null, hash: hashWorld(follow.world) });
    this.memory.append({ t: now(), kind: "response", text: follow.memory.response });
    if (local) this.playMoment(follow, clipID, null);
    else {
      this.committedClipID = clipID;
      this.playNow(clipID);
    }
    this.ahead.publish();
    this.ahead.pump();
    return true;
  }

  /** Lets inputs in again, logging why, and replays the input kept during the lock. */
  private unlock(reason: string): void {
    const locked = this.state.locked;
    if (locked === null) return;
    this.lock.unlock();
    record("input_unlocked", { inputID: locked, reason });
    this.set({ locked: null });
    queueMicrotask(() => {
      this.replayHeld();
    });
  }

  /**
   * The lock's deadline passed before the answer's first frame: an answer still being written is
   * dropped, so the stage and the world stay as they were, and the input fails and unlocks. An
   * answer already filming still plays if it lands before the next input.
   */
  private missedLock(inputID: string, milliseconds: number): void {
    if (this.state.locked !== inputID) return;
    record("deadline_missed", { call: "input_lock", milliseconds, inputID });
    if (!this.consistent) {
      this.ahead.dropGuesses("lock_deadline");
      this.becomeConsistent();
    }
    this.fail("lock_deadline", `no first frame within ${milliseconds} ms of the input`, inputID);
  }

  /**
   * Logs a named failure, shows it in the UI, marks its input, stops the busy state, lifts the
   * input lock and reopens input on the held frame on stage: the one failure path, which clears
   * every flag a failure owns.
   */
  private fail(name: string, detail: string, inputID: string | null = null): void {
    record(name, { inputID, detail });
    if (inputID === null || inputID === this.state.locked) this.unlock(name);
    if (inputID !== null) this.updateInput(inputID, { failed: `${name}: ${detail}` });
    this.set({ error: `${name}: ${detail}`, busy: false });
    this.stageBoxes.reopen(name);
  }

  private startWatchdog(name: string, milliseconds: number, onMiss: () => void): void {
    this.clearWatchdog();
    this.watchdog = {
      name,
      timer: setTimeout(() => {
        this.watchdog = null;
        record("stall", { call: name, milliseconds });
        onMiss();
      }, milliseconds),
    };
  }

  /** Stops the watchdog, or only the one of that name when a name is given. */
  private clearWatchdog(name: string | null = null): void {
    if (this.watchdog === null || (name !== null && this.watchdog.name !== name)) return;
    clearTimeout(this.watchdog.timer);
    this.watchdog = null;
  }

  private onOmniMessage(slot: Slot, message: OmniMessage): void {
    switch (message.type) {
      case "clip_generated": {
        const clipID = message.clip.clip_id;
        record("clip_generated", {
          slot: slot.index,
          clipID,
          buildSeconds: message.clip.build_seconds ?? null,
        });
        slot.builtOrder.push(clipID);
        slot.inFlight.delete(clipID);
        const clip = this.clips.get(clipID);
        if (clip === undefined) return;
        clip.built = true;
        if (clip.popped)
          record("build_dropped", {
            slot: slot.index,
            clipID,
            key: clip.moment?.key ?? null,
            reason: "pruned while it ran",
          });
        if (clip.moment?.status === "filming" && clip.moment.clipID === clipID)
          clip.moment.status = "built";
        this.ahead.publish();
        if (clipID === this.committedClipID) this.clearWatchdog();
        this.clips.settle(clipID);
        const built = clip.moment;
        if (built !== null && built.clipID === clipID && this.tree.holds(built))
          this.ahead.capture(built, slot, clipID, slot.builtOrder.length);
        this.ahead.pump();
        if (built !== null && isFollow(built) && built.parentKey === this.tree.root?.key)
          this.continueChain();
        return;
      }
      case "clip_started": {
        const clipID = message.clip.clip_id;
        record("clip_started", { slot: slot.index, clipID });
        slot.playingClipID = clipID;
        this.set({ playing: true });
        const clip = this.clips.get(clipID);
        if (clip !== undefined) clip.played = true;
        if (clipID !== this.committedClipID) {
          this.publishSlots();
          return;
        }
        this.startWatchdog("first_frame", firstFrameMs, () => {
          if (!this.frames.awaitingFirstFrame(clipID)) return;
          const answered = this.state.inputs.find((item) => item.clipID === clipID);
          const detail = `no frame painted within ${firstFrameMs} ms of clip_started`;
          if (answered === undefined) {
            record("first_frame_stall", { clipID, inputID: null, detail });
            return;
          }
          this.fail("first_frame_stall", detail, answered.inputID);
        });
        if (this.state.localPlayer !== null) {
          record("local_off_stage", { player: this.state.localPlayer, slot: slot.index, clipID });
          this.players.leaveStage();
          this.set({ localPlayer: null });
        }
        if (slot.index !== this.state.activeSlot) {
          record("slot_switch", { from: this.state.activeSlot, to: slot.index, clipID });
          this.set({ activeSlot: slot.index });
          for (const other of this.pool.all)
            if (other !== slot && other.playingClipID !== null)
              this.pool.stop(other, "slot_switch");
        }
        this.frames.await(clipID);
        this.frames.settle(clipID);
        this.set({ boxesSource: null, heldReady: false, busy: false });
        this.publishSlots();
        this.stageBoxes.invalidate();
        this.stageBoxes.startSampling();
        for (const seconds of responseFrameSeconds)
          this.later(seconds * 1000, () => {
            if (slot.playingClipID === clipID) this.saveFrame(clipID, `${seconds}s`);
          });
        return;
      }
      case "clip_finished":
      case "clip_stopped": {
        const clipID = message.clip.clip_id;
        record(message.type, {
          slot: slot.index,
          clipID,
          secondsSent: message.seconds_sent ?? null,
        });
        slot.playingClipID = null;
        this.set({ playing: this.pool.all.some((other) => other.playingClipID !== null) });
        this.publishSlots();
        const pending = slot.pendingPlayClipID;
        if (pending !== null) {
          slot.pendingPlayClipID = null;
          void this.play(pending);
          return;
        }
        if (clipID === this.committedClipID) {
          this.stageBoxes.stopSampling();
          this.endedClipID = clipID;
          if (this.continueChain()) return;
          const moment = this.clips.get(clipID)?.moment ?? null;
          if (moment !== null && moment === this.tree.root && moment.clipID === clipID) {
            if (moment.clipURL !== null) this.players.show(moment, false);
            if (moment.clipURL !== null || this.ahead.boxingOf(moment) !== undefined) {
              void this.stageBoxes.hold(moment);
              return;
            }
          }
          void this.stageBoxes.held(clipID);
          return;
        }
        if (this.stageBoxes.onStage(clipID)) {
          this.stageBoxes.stopSampling();
          void this.stageBoxes.held(clipID);
          return;
        }
        this.stageBoxes.reopen("off_track_finished");
        return;
      }
      case "clip_failed": {
        record("clip_failed", {
          slot: slot.index,
          clipID: message.clip.clip_id,
          reason: message.reason ?? null,
        });
        slot.inFlight.delete(message.clip.clip_id);
        const clip = this.clips.get(message.clip.clip_id);
        if (clip?.moment != null && clip.moment.clipID === message.clip.clip_id) {
          clip.moment.status = "rejected";
          clip.moment.refilms++;
        }
        this.ahead.pump();
        if (message.clip.clip_id === this.committedClipID) {
          this.markInput(message.clip.clip_id, { failed: message.reason ?? "clip failed" });
          this.set({ busy: false });
          this.unlock("clip_failed");
          this.stageBoxes.reopen("clip_failed");
        }
        return;
      }
      case "command_error": {
        const raced = this.racedCommand(slot, message.command, message.reason);
        record(raced === null ? "command_error" : "command_raced", {
          slot: slot.index,
          command: message.command,
          reason: message.reason,
          ...(raced === null ? {} : { why: raced }),
        });
        return;
      }
      case "clip_queued":
      case "clip_popped":
      case "queue_update":
      case "state_update":
        return;
    }
  }

  /**
   * Why a refused command lost a race the app cannot avoid, or null for a real error: a stop that
   * reached a slot whose clip had just finished by itself, or a move for a clip that had just
   * finished building or was popped.
   */
  private racedCommand(slot: Slot, command: string, reason: string): string | null {
    if (command === "stop" && reason.startsWith("not_playing") && slot.playingClipID === null)
      return "the clip finished before the stop arrived";
    const unknown = /^unknown_clip: ([0-9a-f-]+)/.exec(reason)?.[1];
    const clip = unknown === undefined ? undefined : this.clips.get(unknown);
    if (command === "move" && clip !== undefined && (clip.built || clip.popped))
      return clip.built
        ? "the clip finished building before the move arrived"
        : "the clip was popped";
    if (command === "pop" && clip !== undefined && (clip.played || clip.built))
      return "the clip was already played or built";
    return null;
  }

  /**
   * Shows a clip now. On an idle slot it plays at once, even while another slot still plays; on a
   * slot that is playing, that clip is stopped and this one plays the moment it stops.
   */
  private playNow(clipID: string): void {
    if (this.state.paused) {
      this.deferredPlay = clipID;
      record("play_deferred", { clipID });
      return;
    }
    const slot = this.pool.slot(this.clips.get(clipID)?.slot ?? 0);
    if (slot === undefined) return;
    if (slot.playingClipID === null) {
      void this.play(clipID);
      return;
    }
    if (slot.playingClipID === clipID) return;
    slot.pendingPlayClipID = clipID;
    record("cut", { slot: slot.index, from: slot.playingClipID, to: clipID });
    this.pool.stop(slot, "cut");
  }

  private async play(clipID: string, retried = false): Promise<void> {
    if (this.state.paused) {
      this.deferredPlay = clipID;
      record("play_deferred", { clipID });
      return;
    }
    const slot = this.pool.slot(this.clips.get(clipID)?.slot ?? 0);
    this.frames.holdReference(this.video);
    record("play", { slot: slot?.index ?? null, clipID, retried });
    this.startWatchdog("play_start", omniDeadlines.playStart, () => {
      if (!retried) {
        void this.play(clipID, true);
        return;
      }
      this.fail("play_stall", `no clip_started within ${omniDeadlines.playStart} ms, twice`);
    });
    await slot?.client.play(clipID).catch((error: unknown) => {
      record("play_command_failed", { clipID, message: String(error) });
    });
  }

  /**
   * Films a clip again when its held frame does not show what its state added, or still clearly
   * shows what it took away: pinned on the frame on screen, with the same prompt, on the idlest
   * slot, once, in the background. Input is never locked for it: the new clip cuts in when it is
   * built, under the build watchdog, and the next input simply replaces it.
   */
  private async refilm(clipID: string, clip: ClipRecord): Promise<void> {
    const video = this.video;
    const frame = video === null ? null : await captureStill(video);
    if (this.committedClipID !== clipID || this.state.phase !== "running") return;
    const input = this.state.inputs.find((item) => item.clipID === clipID);
    const inputsBefore = this.state.inputs.length;
    const superseded = () =>
      this.state.inputs.length !== inputsBefore || this.committedClipID !== clipID;
    const root = this.tree.root;
    if (root?.clipID !== clipID || this.ahead.followOf(root) !== null) return;
    this.ahead.dropGuesses("refilm");
    const slot = this.pool.idle(this.state.activeSlot);
    record("refilm", {
      clipID,
      slot,
      inputID: input?.inputID ?? null,
      introduced: clip.introduced,
    });
    const sent = await this.send({
      slot,
      request: {
        prompt: clip.prompt,
        seconds: clipLength,
        metadata: `refilm ${clipID}`,
        position: 0,
      },
      moment: root,
      stateOf: clip.stateOf,
      inputID: input?.inputID ?? null,
      pinned: frame,
      wanted: () => !superseded() && this.tree.root === root,
    });
    if (!sent.sent) {
      record("refilm_failed", { clipID, superseded: superseded(), reason: sent.reason });
      return;
    }
    if (superseded()) {
      record("refilm_failed", { clipID, superseded: true });
      this.pool.pop(slot, sent.clipID, popGraceMs);
      return;
    }
    if (input !== undefined) this.updateInput(input.inputID, { clipID: sent.clipID });
    this.committedClipID = sent.clipID;
    root.clipID = sent.clipID;
    root.slot = slot;
    root.held = null;
    root.boxes = null;
    root.checks = null;
    root.status = "filming";
    root.start = frame === null ? "fresh" : "pinned";
    this.showWhenBuilt(sent.clipID);
    this.ahead.pump();
  }

  /** Streams an agent turn once the session is not paused; a paused session asks nothing new. */
  private async agentLines(request: LinesRequest, onLine: (line: string) => void): Promise<void> {
    await this.whenResumed();
    if (request.signal?.aborted === true || this.state.phase !== "running")
      throw new DOMException("aborted", "AbortError");
    await streamLines(request, onLine);
  }

  /** Resolves at once while running, or when the session resumes. */
  private whenResumed(): Promise<void> {
    if (!this.state.paused) return Promise.resolve();
    return new Promise((resolve) => {
      this.resumeWaiters.push(resolve);
    });
  }

  /**
   * Pauses the session: the clip on screen stops and holds its frame, the tree ahead is frozen as
   * it is, and nothing new is asked of the agent, built or played until `resume`. An input being
   * answered keeps its lock and continues on resume. The pool stays connected for the warm pause;
   * past it every session is ended, and `resume` reconnects with every captured moment kept and
   * re-anchors from the held frame.
   */
  pause(): void {
    if (this.state.phase !== "running" || this.state.paused) return;
    this.set({ paused: true });
    this.lock.suspend();
    record("paused", { locked: this.state.locked, warmPauseSeconds: this.knobs.warmPauseSeconds });
    this.stageBoxes.stopSampling();
    const video = this.video;
    void (video === null ? Promise.resolve(null) : captureStill(video)).then((frame) => {
      this.anchorFrame = frame ?? this.anchorFrame;
      if (frame !== null) captureFile(`frames/pause-${String(now())}.jpg`, frame);
    });
    const active = this.pool.slot(this.state.activeSlot);
    if (active !== undefined && active.playingClipID !== null) this.pool.stop(active, "paused");
    this.players.pause();
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      void this.endPoolForPause();
    }, this.knobs.warmPauseSeconds * 1000);
  }

  private async endPoolForPause(): Promise<void> {
    if (!this.state.paused || this.state.phase !== "running" || this.poolEnded) return;
    this.poolEnded = true;
    record("pool_ended_for_pause", { slots: this.pool.all.length });
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.pool.end("pause_limit");
  }

  /**
   * Resumes a paused session where it left off: a deferred clip plays, gated builds and agent
   * calls go ahead, the held frame is boxed again and the frozen tree picks up where it stopped.
   * After a long pause the pool reconnects and, unless an answer is on its way, a clip re-anchored
   * on the held frame brings the picture back.
   */
  resume(): void {
    if (this.state.phase !== "running" || !this.state.paused) return;
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const reconnect = this.poolEnded;
    record("resumed", { reconnect, locked: this.state.locked });
    if (reconnect) this.reconnectPool();
    this.set({ paused: false });
    this.lock.resume();
    queueMicrotask(() => {
      this.replayHeld();
    });
    for (const resolve of this.resumeWaiters.splice(0)) resolve();
    if (reconnect) {
      if (this.state.locked === null) this.reanchor();
      return;
    }
    const deferred = this.deferredPlay;
    this.deferredPlay = null;
    this.players.resume();
    if (deferred !== null && deferred === this.committedClipID) this.playNow(deferred);
    else if (
      !this.continueChain() &&
      this.state.locked === null &&
      this.state.playingClipID === null
    ) {
      const committed = this.committedClipID;
      if (committed !== null) void this.stageBoxes.held(committed);
      this.guessAgain();
    }
  }

  private reconnectPool(): void {
    if (this.keys === null) return;
    this.poolEnded = false;
    this.clips.clear();
    this.committedClipID = null;
    this.deferredPlay = null;
    this.ahead.detach("reconnect");
    this.pool.reconnect();
    this.publishSlots();
  }

  /** Films the current state from the held frame on the first ready slot, then guesses from it. */
  private reanchor(): void {
    const root = this.tree.root;
    if (root === null) return;
    const state = root.state;
    const frame = this.anchorFrame;
    const prompt = openingPrompt(state.world);
    void (async () => {
      const slot = await this.pool.firstReady();
      if (slot === null || this.tree.root !== root) return;
      this.set({ activeSlot: slot.index });
      const sent = await this.send({
        slot: slot.index,
        request: { prompt, seconds: clipLength, metadata: "reanchor", position: 0 },
        moment: root,
        stateOf: () => state,
        inputID: null,
        pinned: frame,
      });
      if (!sent.sent) {
        this.fail("enqueue_refused", `the re-anchoring clip was not sent: ${sent.reason}`);
        return;
      }
      record("reanchored", { clipID: sent.clipID, pinned: frame !== null });
      root.clipID = sent.clipID;
      root.slot = slot.index;
      root.held = null;
      this.committedClipID = sent.clipID;
      this.showWhenBuilt(sent.clipID);
      this.ahead.pump();
    })();
  }

  /** Guesses again from the moment on stage when it has none, and takes up the tree's work. */
  private guessAgain(): void {
    const root = this.tree.root;
    if (root === null || root.children !== "none") return;
    record("guessing_restarted", { roundID: root.key });
    const video = this.video;
    if (video !== null && root.clipID !== null && root.held === null)
      void captureStill(video).then((frame) => {
        if (frame === null || this.tree.root !== root || root.held !== null) return;
        root.held = frame;
        this.ahead.pump();
      });
    this.ahead.pump();
  }

  /** Makes a failed input once more, as it landed the first time. */
  retry(inputID: string): void {
    const again = this.state.inputs.find((input) => input.inputID === inputID)?.again ?? null;
    if (again !== null) this.input(again);
  }

  /**
   * Ends every session of the pool and stops all timers. Each session's server recording is asked
   * for and its disconnect started in the same moment, never one after the other; the end
   * resolves once every session has logged `omni_closed`, and a later call returns the same end.
   */
  end(reason: string): Promise<void> {
    this.ending ??= this.finish(reason);
    return this.ending;
  }

  private async finish(reason: string): Promise<void> {
    this.stageBoxes.stopSampling();
    this.clearWatchdog();
    this.lock.unlock();
    for (const moment of this.tree.all()) moment.abort.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
    this.keeper.stop();
    for (const resolve of this.resumeWaiters.splice(0)) resolve();
    this.set({ phase: "ended", busy: false, paused: false });
    record("run_end", { reason });
    this.stopPersist?.();
    for (const stop of this.stopWatching.splice(0)) stop();
    this.writeIndex(reason);
    writeAgentReplay();
    flushNow();
    await Promise.all([
      this.recorder.stop(),
      ...this.pool.requestRecordings(),
      this.pool.end(reason),
    ]);
    this.writeIndex(reason);
    writeAgentReplay();
    this.stopMirror?.();
    flushNow();
  }

  private writeIndex(endReason: string | null): void {
    writeSessionIndex({
      scenario: this.state.scenario.id,
      models: {
        agent: agentModel,
        jev: this.keys === null ? null : getJevConnection(this.keys).model,
        omni: omniModel,
      },
      poolSize: this.pool.all.length,
      build: this.build,
      inputs: this.state.inputs,
      endReason,
    });
  }

  /** This scenario packed as a folder zip, its saved moments included, or null for a preset. */
  exportFolder(): Promise<Blob | null> {
    return scenarioFolder(this.state.scenario.id);
  }

  /** Every run-log event so far, for the driver. */
  summaryEvents(): readonly RunEvent[] {
    return getEvents();
  }

  /** Per-input timings for the driver and the proof. */
  summary(): {
    runID: string;
    inputs: InputRecord[];
    blackFrames: number;
    events: number;
  } {
    return {
      runID: getRunID(),
      inputs: this.state.inputs,
      blackFrames: this.state.blackFrames,
      events: getEvents().length,
    };
  }
}
