import type { AgentInput, LinesRequest, LinesTurn } from "../agent/index.ts";
import { cleanBoxes, momentChecks } from "../boxes/index.ts";
import { captureFile } from "../capture/index.ts";
import { getJevConnection, type Keys } from "../keys/index.ts";
import type { Memory } from "../memory/index.ts";
import {
  byLikelihood,
  chosenOf,
  isFollow,
  momentKey,
  MomentTree,
  newMoment,
  nextInput,
  reserveSession,
  schedule,
  type Moment,
  type MomentFields,
  type MomentKeeper,
  type NodeView,
  type SourceView,
} from "../moments/index.ts";
import { frameOfStill, heldStill, seamFromStill } from "../frame/index.ts";
import { boxElements, jevDeadline, type BoxResult, type ElementBox } from "../jev/index.ts";
import type { SessionPool, Slot } from "../pool/index.ts";
import { describeChange, projectEntity, viewOf } from "../projector/index.ts";
import { DeadlineError, now, record, withDeadline } from "../run-log/index.ts";
import type { Draft, View, World } from "../state/index.ts";
import { inputMemory, readGuesses, type GuessBlock, type GuessTaker } from "../turn/index.ts";
import { BuildWatch, type BuildMiss } from "./build-watch.ts";
import { clipLength, sendClip, type ClipRecord, type Clips } from "./clips.ts";
import { guessQuestion, logJev } from "./jev-log.ts";
import type { LocalPlayers } from "./local-players.ts";
import type { Knobs } from "../route/index.ts";
import type { GuessView } from "./state.ts";

/** Guess turns asked of the agent at once; the scheduler's order says which go first. */
const writesInFlight = 6;
/** A guess Jev ranks below this, not built yet, is dropped, unless every thing is answered (`wide`). */
const unlikely = 0.02;
/** How long a popped clip still counts against its session, until the pop has landed. */
const popGraceMs = 6000;
const seamCheckMs = 3000;
/** Recent memory lines Jev reads to rank guesses. */
const rankingMemory = 6;
/** A thing boxed at least this present counts as on the frame. */
const boxedPresence = 0.5;

/** What one guess turn asks for: answers at `count` of `picks`. */
export interface GuessAsk {
  picks: string[];
  count: number;
}

/** What the tree ahead of the stage asks of the controller that owns it. */
export interface AheadHost {
  readonly knobs: Knobs;
  readonly pool: SessionPool;
  readonly clips: Clips;
  /** Where ready moments go and when the run has filmed enough. */
  readonly keeper: MomentKeeper;
  readonly players: LocalPlayers;
  readonly memory: Memory;
  keys: () => Keys | null;
  /** Running, not paused, and the stage consistent with the world: new work may start. */
  open: () => boolean;
  running: () => boolean;
  activeSlot: () => number;
  /** The input the moment on screen answers, for its own guess turn. */
  lastInput: () => AgentInput;
  /** The state on display. */
  shown: () => View;
  /** The boxes found on the frame on stage for the moment on stage, or null before any. */
  stageBoxes: () => readonly ElementBox[] | null;
  setGuesses: (guesses: GuessView[]) => void;
  linesRequest: (turn: LinesTurn, world: World, signal: AbortSignal) => LinesRequest | null;
  agentLines: (request: LinesRequest, onLine: (line: string) => void) => Promise<void>;
  playingNow: () => boolean;
  /** The clip the stage waits on or plays, whose build the controller watches itself. */
  committedClipID: () => string | null;
  /** A hit's moment was sent: its clip is the answer now. */
  commitClip: (moment: Moment, clipID: string, inputID: string) => void;
  /** A hit's moment could not be sent. */
  failAwaited: (inputID: string, detail: string) => void;
  /** The moment on screen failed its checks after it played: film it again from the frame on stage. */
  refilmStage: (clipID: string, clip: ClipRecord) => void;
  /** A moment on stage from local media has its boxes now. */
  applyMomentBoxes: (moment: Moment) => void;
}

/**
 * The moments ahead of the stage and all the work on them: writing each moment's guesses,
 * filming them where the scheduler says, capturing every built clip and boxing and checking its
 * held frame before anyone needs it, ranking guesses, and pruning whatever the stage left behind.
 */
export class Ahead {
  readonly tree = new MomentTree();
  /** The moment a hit is waiting on while its clip is still being sent, with its input. */
  private awaited: { moment: Moment; inputID: string } | null = null;
  /** Each moment's running guess turn, aborted when its guesses are dropped. */
  private readonly writes = new Map<Moment, AbortController>();
  /** Each moment's boxing on its held frame, so the stage can wait for it instead of asking Jev. */
  private readonly boxing = new Map<Moment, Promise<void>>();
  /** Each captured moment's seam against its parent's held frame. */
  private readonly seams = new WeakMap<Moment, number | null>();
  /** Moments whose capture already failed once and was tried again. */
  private readonly recaptured = new WeakSet<Moment>();
  /** How many of a moment's guesses Jev last ranked, so a ranking is asked again only for more. */
  private readonly ranked = new WeakMap<Moment, number>();
  /** How many of the root's guesses the stage's own boxing last ranked. */
  rankedCount = 0;
  /** Moments on stage whose remaining things were asked for once they took the stage. */
  private readonly toppedUp = new WeakSet<Moment>();
  /** The deadline on every background build. */
  private readonly builds = new BuildWatch((miss) => {
    this.missedBuild(miss);
  });
  /** Moments whose build already missed its deadline once and were filmed again. */
  private readonly overdue = new WeakSet<Moment>();

  constructor(private readonly host: AheadHost) {}

  /** A new moment under its parent in the tree, written and not yet filmed. */
  moment(fields: MomentFields): Moment {
    return newMoment(fields, fields.parentKey === null ? null : this.tree.get(fields.parentKey));
  }

  /** Whether any moment is being written, captured or boxed. */
  busy(): boolean {
    return this.boxing.size > 0 || this.writes.size > 0;
  }

  /** The boxing still running on a moment's held frame, if any. */
  boxingOf(moment: Moment): Promise<void> | undefined {
    return this.boxing.get(moment);
  }

  /** The root's guesses still worth ranking: every child not rejected. */
  openGuesses(): Moment[] {
    const root = this.tree.root;
    return root === null ? [] : this.guessesOf(root).filter((child) => child.status !== "rejected");
  }

  /** A moment's guesses at the next input: its children but its follow-up. */
  guessesOf(moment: Moment): Moment[] {
    return this.tree.children(moment).filter((child) => !isFollow(child));
  }

  /** The follow-up chained after a moment's clip, or null. */
  followOf(moment: Moment): Moment | null {
    return this.tree.children(moment).find(isFollow) ?? null;
  }

  /**
   * The input a moment's own guess turn says was made: the click on the head of its chain, or the
   * input the stage answers when that head is on stage or already left the tree.
   */
  private inputOf(moment: Moment): AgentInput {
    let head: Moment | null = moment;
    while (head !== null && isFollow(head))
      head = head.parentKey === null ? null : this.tree.get(head.parentKey);
    const input = head?.input ?? null;
    return head === null || head === this.tree.root || input === null
      ? this.host.lastInput()
      : { kind: "click", elementID: input.elementID, label: head.label };
  }

  publish(): void {
    const root = this.tree.root;
    this.host.setGuesses(
      (root === null ? [] : this.guessesOf(root)).flatMap((child) =>
        child.input === null
          ? []
          : [
              {
                elementID: child.input.elementID,
                action: child.input.action,
                status: child.status,
                clipID: child.clipID,
                slot: child.slot,
                likelihood: child.likelihood,
                baked: child.baked,
              },
            ],
      ),
    );
  }

  /** Starts the tree over from a moment, dropping everything that was ahead of the stage. */
  plant(root: Moment): void {
    this.drop(this.tree.plant(root), "replanted");
    this.publish();
  }

  /** Makes a moment the root, dropping everything outside it. */
  reRoot(moment: Moment, reason: string): void {
    this.drop(this.tree.reRoot(moment), reason);
    this.rankedCount = 0;
  }

  /** A hit waits on this moment's clip, still being sent. */
  await(moment: Moment, inputID: string): void {
    this.awaited = { moment, inputID };
  }

  /** The hit no longer waits on this moment: its clip is the answer. */
  settleAwaited(moment: Moment): void {
    if (this.awaited?.moment === moment) this.awaited = null;
  }

  /**
   * Drops the root's guesses and stops its guess turn: a miss, a pause or a refilm answers from the
   * world as it is, so nothing guessed from it is kept.
   */
  dropGuesses(reason: string): void {
    const root = this.tree.root;
    if (root === null) return;
    this.writes.get(root)?.abort();
    this.writes.delete(root);
    root.children = "none";
    for (const child of this.tree.children(root)) this.drop(this.tree.cut(child), reason);
    this.rankedCount = 0;
    this.publish();
  }

  /**
   * Lets go of everything the pool's sessions held, for a reconnect: the moment on stage loses its
   * clip, every captured moment keeps its local media as a clip with no session, and every moment
   * filming or built on a session goes back to written, to be filmed again on the new sessions.
   */
  detach(reason: string): void {
    const root = this.tree.root;
    let kept = 0;
    let rewritten = 0;
    for (const moment of this.tree.all()) {
      if (moment === root) {
        moment.clipID = null;
        moment.slot = null;
        continue;
      }
      const local =
        moment.clipID !== null &&
        moment.clipURL !== null &&
        moment.held !== null &&
        (moment.status === "captured" || moment.status === "ready");
      if (local && moment.clipID !== null) {
        this.host.clips.local(moment.clipID, moment);
        moment.slot = null;
        kept++;
      } else if (moment.status !== "rejected" && moment.status !== "written") {
        moment.status = "written";
        moment.clipID = null;
        moment.slot = null;
        moment.start = null;
        rewritten++;
      }
    }
    this.builds.clear();
    record("tree_detached", { reason, kept, rewritten });
    this.publish();
  }

  /**
   * Lets go of moments that left the tree: every agent and Jev call made for them is aborted, and
   * a clip still waiting in a build queue is popped. A build already running is left to finish
   * and is dropped when it lands.
   */
  drop(moments: readonly Moment[], reason: string): void {
    for (const moment of moments) {
      moment.abort.abort();
      this.writes.get(moment)?.abort();
      this.writes.delete(moment);
      if (this.awaited?.moment === moment) this.awaited = null;
      if (moment.clipID !== null) this.popClip(moment.clipID, moment, reason);
    }
  }

  /** Pops a clip that was never played from its slot's queues; a running build still finishes. */
  popClip(clipID: string, moment: Moment | null, reason: string, graceMs = popGraceMs): void {
    this.builds.settle(clipID);
    const clip = this.host.clips.get(clipID);
    if (clip === undefined || clip.played || clip.popped || clip.slot < 0) return;
    clip.popped = true;
    record("speculation_popped", {
      clipID,
      slot: clip.slot,
      elementID: moment?.input?.elementID ?? null,
      built: clip.built,
      reason,
    });
    this.host.pool.pop(clip.slot, clipID, graceMs);
  }

  /** A session finished a build or failed one: its deadline stops and the session is alive. */
  buildSettled(slotIndex: number, clipID: string): void {
    this.builds.settle(clipID);
    this.builds.progressed(slotIndex);
  }

  /** A session reached ready, so its deadlines count from now. */
  sessionStarted(slotIndex: number): void {
    this.builds.progressed(slotIndex);
  }

  /**
   * A background build missed its deadline: it is popped and its place on the session released
   * at once, its moment goes back to written to be filmed again, once (a second miss rejects it),
   * and a session that finished nothing in that time is recycled unless the stage is on it. Checked
   * again later while new work is closed, and left alone once the stage waits on it.
   */
  private missedBuild(miss: BuildMiss): void {
    const host = this.host;
    const clip = host.clips.get(miss.clipID);
    if (!host.running() || clip === undefined || clip.built || clip.popped) return;
    if (clip.slot !== miss.slot || host.committedClipID() === miss.clipID) return;
    if (!host.open()) {
      this.builds.watch(miss.clipID, miss.slot, 0);
      return;
    }
    const moment = clip.moment;
    const slot = host.pool.slot(miss.slot);
    const held = moment !== null && this.tree.holds(moment) && moment.clipID === miss.clipID;
    const rescheduled = held && !this.overdue.has(moment);
    const recycle =
      miss.wedged &&
      slot !== undefined &&
      slot.playingClipID === null &&
      miss.slot !== host.activeSlot() &&
      miss.slot !== this.tree.root?.slot;
    record("build_deadline", {
      clipID: miss.clipID,
      slot: miss.slot,
      key: moment?.key ?? null,
      milliseconds: miss.milliseconds,
      wedged: miss.wedged,
      rescheduled,
      recycled: recycle,
    });
    this.popClip(miss.clipID, moment, "build_deadline", 0);
    if (held) {
      this.unfilmFollows(moment, "build_deadline");
      moment.clipID = null;
      moment.slot = null;
      moment.start = null;
      if (rescheduled) {
        this.overdue.add(moment);
        moment.status = "written";
      } else {
        moment.status = "rejected";
        moment.refilms++;
      }
    }
    if (recycle) this.recycleSession(miss.slot);
    this.publish();
    this.pump();
  }

  /**
   * Replaces a wedged session: every captured moment it built keeps its local media as a clip
   * with no session, and every moment filming or built on it goes back to written, to be filmed
   * again elsewhere or on its fresh session.
   */
  private recycleSession(slotIndex: number): void {
    const root = this.tree.root;
    for (const moment of this.tree.all()) {
      const clipID = moment.clipID;
      if (moment === root || moment.slot !== slotIndex || clipID === null) continue;
      this.builds.settle(clipID);
      if (moment.clipURL !== null && moment.held !== null && moment.status !== "filming") {
        this.host.clips.local(clipID, moment);
        moment.slot = null;
        continue;
      }
      const clip = this.host.clips.get(clipID);
      if (clip !== undefined) clip.popped = true;
      if (moment.status === "rejected") continue;
      moment.status = "written";
      moment.clipID = null;
      moment.slot = null;
      moment.start = null;
    }
    this.host.pool.recycle(slotIndex, "build_deadline");
  }

  /** A moment's guess turn is running under `abort`. */
  startWriting(moment: Moment, abort: AbortController): void {
    moment.children = "writing";
    this.writes.set(moment, abort);
  }

  /** The moment a guess turn under `abort` writes for now, its writing moved down any chain. */
  private writingUnder(abort: AbortController): Moment | null {
    for (const [moment, writing] of this.writes) if (writing === abort) return moment;
    return null;
  }

  /** A moment's guess turn under `abort` ended: its guesses are in, ranked and scheduled. */
  finishWriting(abort: AbortController): void {
    const moment = this.writingUnder(abort);
    if (moment === null) return;
    this.writes.delete(moment);
    moment.children = "written";
    this.rankLater(moment);
    this.pump();
  }

  /** A moment's guess turn under `abort` was given up before any guess. */
  abandonWriting(abort: AbortController): void {
    const moment = this.writingUnder(abort);
    if (moment === null) return;
    this.writes.delete(moment);
    moment.children = "none";
  }

  /** The moment's turn moved on to a new moment: its writing is done, nothing more comes. */
  handOff(from: Moment, to: Moment, abort: AbortController): void {
    this.writes.delete(from);
    from.children = "written";
    this.tree.add(to);
    this.reRoot(to, "round_closed");
    to.status = "filming";
    this.startWriting(to, abort);
  }

  /**
   * Starts the work the tree is ready for: the scheduler is given the tree and the pool and says
   * which moments to write guesses for and which to film where; this only carries it out. Runs
   * after anything that could open new work, and does nothing while an answer is being written,
   * while paused or before the stage has a clip.
   */
  pump(): void {
    if (!this.host.open()) return;
    const root = this.tree.root;
    if (root === null) return;
    const knobs = this.host.knobs;
    const views = this.host.pool.all.map((slot) => ({
      index: slot.index,
      ready: slot.ready,
      outstanding: slot.inFlight.size + slot.sending,
    }));
    const reserve = reserveSession(views, root.slot);
    const nodes: NodeView[] = [];
    const sources: SourceView[] = [];
    for (const moment of this.tree.all()) {
      const depth = this.tree.steps(moment);
      if (depth === null) continue;
      nodes.push({
        key: moment.key,
        parentKey: moment.parentKey,
        depth,
        follow: isFollow(moment),
        probability: this.tree.pathProbability(moment),
        index: moment.index,
        status: moment.status,
        children: moment.children,
        refilms: moment.refilms,
      });
      sources.push({
        key: moment.key,
        retainedOn: this.retainedOn(moment),
        held: moment.held !== null,
      });
    }
    const plan = schedule(
      nodes,
      sources,
      views.map((view) => ({ ...view, reserved: view.index === reserve })),
      { filmDepth: knobs.depth, writeDepth: knobs.write, perSession: knobs.budget },
    );
    for (const key of plan.write) {
      const moment = this.tree.get(key);
      if (moment === null) continue;
      if (moment !== root && this.writes.size >= writesInFlight) break;
      this.writeGuesses(moment, this.inputOf(moment), moment.key, this.ask(moment));
    }
    if (
      knobs.wide &&
      root.children === "written" &&
      this.followOf(root) === null &&
      !this.toppedUp.has(root)
    ) {
      this.toppedUp.add(root);
      const ask = this.ask(root);
      if (ask.count > 0) {
        record("guesses_topped_up", { roundID: root.key, picks: ask.picks });
        this.writeGuesses(root, this.host.lastInput(), root.key, ask);
      }
    }
    for (const order of this.host.keeper.full() ? [] : plan.film) {
      const moment = this.tree.get(order.key);
      const parent = moment?.parentKey == null ? null : this.tree.get(moment.parentKey);
      if (moment === null || parent === null) continue;
      const position = isFollow(moment) && this.tree.steps(moment) === 0 ? { position: 0 } : {};
      if (order.start === "latent")
        void this.film(moment, order.slot, "latent", {
          continueFrom: parent.clipID,
          fallback: parent.held,
          ...position,
        });
      else void this.film(moment, order.slot, "pinned", { pinned: parent.held, ...position });
    }
    this.warmLikeliest();
  }

  /**
   * Keeps the follow-up of the moment on stage warmed in the player off stage once it is captured,
   * else its likeliest captured guess.
   */
  warmLikeliest(): void {
    const root = this.tree.root;
    if (root === null) return;
    const follow = this.followOf(root);
    this.host.players.warm(
      byLikelihood(
        (follow === null ? this.tree.children(root) : [follow]).filter(
          (child) =>
            child.clipURL !== null && (child.status === "ready" || child.status === "captured"),
        ),
      )[0],
    );
  }

  /** The slot whose last built clips still hold this moment's clip, so a child can continue it. */
  private retainedOn(moment: Moment): number | null {
    const clipID = moment.clipID;
    if (clipID === null) return null;
    const clip = this.host.clips.get(clipID);
    const slot = clip === undefined ? undefined : this.host.pool.slot(clip.slot);
    if (slot === undefined || !clip?.built || clip.popped || !slot.ready) return null;
    return this.host.pool.retains(slot, clipID) ? slot.index : null;
  }

  /**
   * Films one moment on a slot: continuing `continueFrom` there, or pinned on `pinned`, or fresh.
   * The moment is checked against the tree the instant before it is sent, so nothing pruned is
   * ever sent; a clip that lands for a moment pruned meanwhile is popped. Position 0 puts it at
   * the front of the slot's queue, for an answer the lock waits on.
   */
  async film(
    moment: Moment,
    slotIndex: number,
    start: "latent" | "pinned" | "fresh",
    from: {
      pinned?: Blob | null;
      continueFrom?: string | null;
      position?: number;
      fallback?: Blob | null;
    },
  ): Promise<void> {
    const host = this.host;
    const slot = host.pool.slot(slotIndex);
    if (slot === undefined) return;
    this.unfilmFollows(moment, "refilm");
    moment.status = "filming";
    moment.slot = slotIndex;
    moment.start = start;
    slot.sending++;
    this.publish();
    const position = from.position;
    const sent = await sendClip(host.pool, host.clips, host.shown, {
      slot: slotIndex,
      request: {
        prompt: moment.prompt,
        seconds: clipLength,
        metadata: `moment ${moment.key}`,
        ...(position === undefined ? {} : { position }),
      },
      moment,
      stateOf: () => moment.state,
      inputID: this.awaited?.moment === moment ? this.awaited.inputID : null,
      continueFrom: start === "latent" ? (from.continueFrom ?? null) : null,
      pinned: start === "pinned" ? (from.pinned ?? null) : null,
      fallback: start === "latent" ? (from.fallback ?? null) : null,
      wanted: () => this.tree.holds(moment),
    }).finally(() => {
      slot.sending--;
    });
    if (!sent.sent) {
      if (this.tree.holds(moment)) {
        moment.status = "rejected";
        moment.refilms++;
        const awaited = this.awaited;
        if (awaited?.moment === moment) {
          this.awaited = null;
          host.failAwaited(awaited.inputID, `the chosen clip was not sent: ${sent.reason}`);
        }
      }
      this.publish();
      this.pump();
      return;
    }
    moment.clipID = sent.clipID;
    if (!this.tree.holds(moment)) {
      this.drop([moment], "round_closed");
      return;
    }
    const awaited = this.awaited;
    if (awaited?.moment === moment) host.commitClip(moment, sent.clipID, awaited.inputID);
    else this.builds.watch(sent.clipID, slotIndex, Math.max(0, slot.inFlight.size - 1));
    this.publish();
    this.pump();
  }

  /**
   * Asks the agent for a moment's guesses at the next input, each with its answer, in the line
   * format. A call that misses its deadline before any guess arrived is made once more at once
   * while the moment is still in the tree.
   */
  writeGuesses(
    moment: Moment,
    input: AgentInput,
    inputID: string,
    ask: GuessAsk,
    retried = false,
  ): void {
    const local = new AbortController();
    const onAbort = () => {
      local.abort();
    };
    moment.abort.signal.addEventListener("abort", onAbort);
    this.writes.get(moment)?.abort();
    this.startWriting(moment, local);
    if (ask.count === 0) {
      this.finishWriting(local);
      return;
    }
    const request = this.host.linesRequest(
      { kind: "speculate", input, picks: ask.picks, count: ask.count },
      moment.world,
      local.signal,
    );
    if (request === null) return;
    const guesses = this.guessesFor(moment, ask.count, false, local.signal);
    this.host
      .agentLines(request, (line) => {
        if (!local.signal.aborted && !guesses.take(line)) local.abort();
      })
      .then(() => {
        guesses.end();
        this.finishWriting(local);
      })
      .catch((error: unknown) => {
        guesses.end();
        if (moment.abort.signal.aborted || this.writes.get(moment) !== local) return;
        if (!local.signal.aborted || error instanceof DeadlineError)
          record("speculate_failed", { inputID, message: String(error) });
        if (
          error instanceof DeadlineError &&
          !retried &&
          this.tree.holds(moment) &&
          this.tree.children(moment).length === 0
        ) {
          record("retry", { call: "speculate", inputID, reason: String(error) });
          this.writeGuesses(moment, input, inputID, ask, true);
          return;
        }
        this.finishWriting(local);
      })
      .finally(() => {
        moment.abort.signal.removeEventListener("abort", onAbort);
      });
  }

  /**
   * What a moment's guess turn asks for: the things on it that take a click (only those boxed on
   * its frame, once it has boxes) not answered yet. The moment on stage asks for all of them with
   * `wide`; one step ahead asks for the `guesses` likeliest, and deeper ones for one fewer.
   */
  ask(moment: Moment): GuessAsk {
    const depth = this.tree.depth(moment) ?? 0;
    const knobs = this.host.knobs;
    const clickable = moment.state.elements
      .filter((element) => element.kind !== "input")
      .map((element) => element.id);
    const boxes = moment.boxes ?? (moment === this.tree.root ? this.host.stageBoxes() : null);
    const boxed = new Set(
      (boxes ?? [])
        .filter((found) => found.presence >= boxedPresence)
        .map((found) => found.elementID),
    );
    const answered = new Set(
      this.tree
        .children(moment)
        .flatMap((child) => (child.input === null ? [] : [child.input.elementID])),
    );
    const picks = clickable.filter(
      (id) => (boxed.size === 0 || boxed.has(id)) && !answered.has(id),
    );
    const wanted = !knobs.wide
      ? knobs.guesses
      : depth === 0
        ? picks.length
        : depth === 1
          ? knobs.guesses
          : Math.max(1, knobs.guesses - 1);
    return { picks, count: Math.min(wanted, picks.length) };
  }

  /**
   * Reads streamed guesses for a moment, each finished guess becoming its child. With `chained`,
   * follow-ups written before the guesses chain after the moment first, each the child of the one
   * before, its turn's writing moving down to the newest, and the guesses go under the last. Once
   * `signal` aborts, nothing more is added, not even the guess its stream was cut off in.
   */
  guessesFor(
    parent: Moment,
    limit = this.host.knobs.guesses,
    chained = false,
    signal: AbortSignal | null = null,
  ): GuessTaker {
    let end: Moment | null = parent;
    return readGuesses({
      world: parent.world,
      limit,
      roundID: parent.key,
      alive: () => signal?.aborted !== true && end !== null && this.tree.holds(end),
      onGuess: (block) => {
        if (end !== null) this.addGuess(end, block);
      },
      ...(chained
        ? {
            onFollow: (draft: Draft, continues: boolean) => {
              end = end === null ? null : this.addFollow(end, draft, continues);
            },
          }
        : {}),
    });
  }

  /**
   * Chains a follow-up after a moment: what happens next on its own once the moment's clip ends,
   * filmed as a continuation of it. Its clip keeps moving into the next one when `continues`. A
   * guess turn still writing for the moment moves down to it. Returns it, or null when it was not
   * added.
   */
  private addFollow(parent: Moment, draft: Draft, continues: boolean): Moment | null {
    try {
      const follow = this.moment({
        key: momentKey(parent.key, nextInput, draft.lines),
        parentKey: parent.key,
        input: nextInput,
        index: 0,
        label: parent.label,
        lines: draft.lines,
        ops: draft.ops,
        world: draft.world,
        state: viewOf(draft.world),
        beat: describeChange(parent.world, draft.world, draft.ops),
        likelihood: 1,
        memory: { input: "", response: draft.lines.join("; ") },
        prompt: projectEntity(draft.world, null, parent.world, draft.ops, !continues).prompt,
      });
      if (!this.tree.add(follow)) return null;
      const writing = this.writes.get(parent);
      parent.children = "written";
      if (writing !== undefined) {
        this.writes.delete(parent);
        this.startWriting(follow, writing);
      }
      record("follow_added", {
        roundID: parent.key,
        key: follow.key,
        continues,
        lines: draft.lines.length,
      });
      this.pump();
      return follow;
    } catch (error: unknown) {
      record("follow_rejected", { roundID: parent.key, guess: null, errors: [String(error)] });
      return null;
    }
  }

  /**
   * Sends a moment's follow-ups filmed from its earlier clip back to written, popping what is
   * still queued, so they are filmed again from its new one.
   */
  private unfilmFollows(moment: Moment, reason: string): void {
    for (let follow = this.followOf(moment); follow !== null; follow = this.followOf(follow)) {
      if (follow.status === "written") continue;
      if (follow.clipID !== null) this.popClip(follow.clipID, follow, reason);
      follow.status = "written";
      follow.clipID = null;
      follow.clipURL = null;
      follow.clip = null;
      follow.held = null;
      follow.boxes = null;
      follow.checks = null;
      follow.slot = null;
      follow.start = null;
    }
  }

  private addGuess(parent: Moment, block: GuessBlock): void {
    const { draft, guess, follows } = block;
    const start = parent.world;
    const element = parent.state.elements.find((item) => item.id === guess.elementID);
    if (element === undefined) {
      record("candidate_unknown_element", { roundID: parent.key, elementID: guess.elementID });
      return;
    }
    try {
      const input: AgentInput = { kind: "click", elementID: element.id, label: element.label };
      const child = this.moment({
        key: momentKey(parent.key, guess, draft.lines),
        parentKey: parent.key,
        input: guess,
        index: block.index,
        label: element.label,
        lines: draft.lines,
        ops: draft.ops,
        world: draft.world,
        state: viewOf(draft.world),
        beat: describeChange(start, draft.world, draft.ops),
        likelihood: block.likelihood,
        memory: {
          input: inputMemory(input),
          response: `played the guessed clip for ${element.label}`,
        },
        prompt: projectEntity(draft.world, input, start, draft.ops, follows.length === 0).prompt,
      });
      if (!this.tree.add(child)) return;
      let end = child;
      for (const [index, follow] of follows.entries()) {
        const added = this.addFollow(end, follow, index < follows.length - 1);
        if (added === null) break;
        end = added;
      }
      record("speculation_added", {
        roundID: parent.key,
        key: child.key,
        index: child.index,
        elementID: guess.elementID,
        action: guess.action,
        likelihood: child.likelihood,
      });
      this.publish();
      this.pump();
    } catch (error: unknown) {
      record("guess_rejected", {
        roundID: parent.key,
        elementID: guess.elementID,
        errors: [String(error)],
      });
    }
  }

  /**
   * Takes Jev's likelihoods for the open guesses in place of the agent's: drops the ones not yet
   * built that became unlikely, moves the rest of the waiting builds into likelihood order on their
   * slots, and lets the scheduler place the unsent ones by the new order.
   */
  applyLikelihoods(children: Moment[], likelihoods: number[]): void {
    children.forEach((child, index) => {
      child.likelihood = likelihoods[index] ?? child.likelihood;
    });
    this.rankedCount = children.length;
    record("guesses_ranked", {
      ranking: children.map((child) => ({
        elementID: child.input?.elementID ?? null,
        likelihood: child.likelihood,
      })),
    });
    for (const child of children)
      if (
        !this.host.knobs.wide &&
        child.likelihood !== null &&
        child.likelihood < unlikely &&
        (child.status === "written" || child.status === "filming")
      ) {
        record("guess_unlikely", { elementID: child.input?.elementID ?? null });
        this.drop(this.tree.cut(child), "unlikely");
      }
    const waiting = byLikelihood(children).filter(
      (child) => child.status === "filming" && this.tree.holds(child),
    );
    for (const child of [...waiting].reverse()) {
      const clipID = child.clipID;
      if (clipID === null) continue;
      this.host.pool.moveToFront(this.host.clips.get(clipID)?.slot ?? 0, clipID);
    }
    this.publish();
    this.pump();
  }

  /** Runs a boxing of a moment's held frame, tracked until it settles. */
  private track(moment: Moment, work: () => Promise<void>): void {
    const running = work().finally(() => {
      if (this.boxing.get(moment) === running) this.boxing.delete(moment);
    });
    this.boxing.set(moment, running);
  }

  /** Boxes a loaded moment again, for a saved tree whose Jev model changed. */
  rebox(moment: Moment): void {
    moment.checks = null;
    this.track(moment, () => this.boxMoment(moment));
  }

  /**
   * Captures a built moment before anyone sees it: its step result gives the clip and its true
   * last frame, the held frame goes to every ready session at once so a pinned child never waits
   * on an upload, and Jev boxes and checks it. Runs for every built moment in the tree. A capture
   * that fails is tried once more, then rejects the moment and refilms it, so it never stays built.
   */
  capture(moment: Moment, slot: Slot, clipID: string, step: number): void {
    const read = slot.client.stepResult;
    if (read === undefined) return;
    const host = this.host;
    const started = now();
    this.track(moment, () =>
      read
        .call(slot.client, step, clipID, moment.abort.signal)
        .then(async (media) => {
          const held = await heldStill(media.lastFrame);
          if (!this.tree.holds(moment) || moment.clipID !== clipID) return;
          if (moment.clipURL !== null) URL.revokeObjectURL(moment.clipURL);
          moment.clipURL = URL.createObjectURL(media.clip);
          moment.clip = media.clip;
          moment.held = held;
          if (moment.status === "built" || moment.status === "filming") moment.status = "captured";
          record("moment_captured", {
            key: moment.key,
            clipID,
            slot: slot.index,
            step,
            listedMs: media.listedMs,
            downloadedMs: media.downloadedMs,
            seconds: Math.round((now() - started) * 100) / 100,
            clipBytes: media.clip.size,
            heldBytes: held.size,
          });
          captureFile(`moments/${clipID.slice(0, 8)}-held.jpg`, held);
          host.pool.uploadEverywhere(held);
          this.publish();
          this.pump();
          if (moment === this.tree.root && host.players.load === null && !host.playingNow())
            host.players.show(moment, false);
          const parent = moment.parentKey === null ? null : this.tree.get(moment.parentKey);
          const parentHeld = parent?.held ?? null;
          const clipURL = moment.clipURL;
          const seam =
            moment.start !== "fresh" && parentHeld !== null
              ? await withDeadline("seam_check", seamCheckMs, () =>
                  seamFromStill(clipURL, parentHeld),
                ).catch(() => null)
              : null;
          if (seam !== null) record("seam_check", { key: moment.key, clipID, seam });
          this.seams.set(moment, seam);
          await this.boxMoment(moment);
        })
        .catch((error: unknown) => {
          if (moment.abort.signal.aborted) return;
          record("capture_failed", { key: moment.key, clipID, step, message: String(error) });
          if (!this.tree.holds(moment) || moment.clipID !== clipID) return;
          if (!this.recaptured.has(moment)) {
            this.recaptured.add(moment);
            this.capture(moment, slot, clipID, step);
            return;
          }
          moment.status = "rejected";
          this.refilm(moment);
          this.publish();
        }),
    );
  }

  /**
   * Boxes a captured moment on its own held frame and checks it the way the stage used to after
   * playing it. Jev also ranks its guesses when two or more are written and not ranked yet. A
   * moment that fails is refilmed in the background, once; input never waits on it.
   */
  private async boxMoment(moment: Moment): Promise<void> {
    const keys = this.host.keys();
    const held = moment.held;
    if (keys === null || held === null) return;
    const frame = await frameOfStill(held);
    const children = this.guessesOf(moment).filter((child) => child.status !== "rejected");
    const rank = children.length >= 2 && this.ranked.get(moment) !== children.length;
    const guesses = rank ? children.map(guessQuestion) : [];
    const elements = [...moment.state.elements, ...moment.removed];
    const started = performance.now();
    record("boxes_requested", {
      source: "capture",
      key: moment.key,
      clipID: moment.clipID,
      elements: elements.length,
      guesses: guesses.length,
      frameLuma: frame.luma,
    });
    let result: BoxResult | null = null;
    for (let attempt = 0; attempt < 2 && result === null; attempt++)
      result = await withDeadline("jev_boxes", jevDeadline, (signal) =>
        boxElements(
          getJevConnection(keys),
          frame.base64,
          elements,
          AbortSignal.any([signal, moment.abort.signal]),
          { guesses, recent: this.host.memory.tail(rankingMemory), degradation: true },
        ),
      ).catch((error: unknown) => {
        record("boxes_failed", { source: "capture", key: moment.key, message: String(error) });
        return null;
      });
    if (result === null || !this.tree.holds(moment)) return;
    logJev(
      "capture",
      { key: moment.key, clipID: moment.clipID },
      frame.base64,
      result,
      Math.round(performance.now() - started),
    );
    const shownIDs = new Set(moment.state.elements.map((element) => element.id));
    const typingIDs = new Set(
      moment.state.elements
        .filter((element) => element.kind === "input")
        .map((element) => element.id),
    );
    const boxes = cleanBoxes(
      result.boxes.filter((found) => shownIDs.has(found.elementID)),
      (found) => typingIDs.has(found.elementID),
    );
    const first = moment.checks === null;
    moment.boxes = boxes;
    if (first) {
      const { subjectPresence, boxable, ...checks } = momentChecks(
        { ...moment, chosen: chosenOf(moment) },
        [...shownIDs],
        boxes,
        result,
        this.seams.get(moment) ?? null,
      );
      moment.checks = checks;
      if (moment.status === "captured" || moment.status === "built")
        moment.status = checks.passed ? "ready" : "rejected";
      record(checks.passed ? "moment_ready" : "moment_rejected", {
        key: moment.key,
        clipID: moment.clipID,
        ...checks,
        subjectPresence,
        boxable,
      });
      if (!checks.passed) this.refilm(moment);
      else this.host.keeper.keep(moment);
    }
    if (rank && result.likelihoods !== null) {
      this.ranked.set(moment, children.length);
      this.applyLikelihoods(children, result.likelihoods);
    }
    const players = this.host.players;
    if (
      moment === this.tree.root &&
      (players.onStage() === moment || players.load?.moment === moment)
    )
      this.host.applyMomentBoxes(moment);
    this.publish();
    this.pump();
  }

  /**
   * Asks Jev to rank a moment's guesses once they are written, when its held frame was boxed
   * before they arrived; a moment still being captured ranks them in its own boxing.
   */
  private rankLater(moment: Moment): void {
    if (moment.held === null || moment.boxes === null || this.boxing.has(moment)) return;
    const children = this.guessesOf(moment).filter((child) => child.status !== "rejected");
    if (children.length < 2 || this.ranked.get(moment) === children.length) return;
    this.track(moment, () => this.boxMoment(moment));
  }

  /**
   * Films a rejected moment again in the background, once: pinned on its parent's held frame with
   * the same prompt on the least loaded session. The moment on screen is refilmed from the frame on stage
   * instead, which cuts in when built.
   */
  private refilm(moment: Moment): void {
    if (moment.refilms > 0 || !this.host.running()) return;
    moment.refilms++;
    const clipID = moment.clipID;
    const clip = clipID === null ? undefined : this.host.clips.get(clipID);
    if (moment === this.tree.root && clipID !== null && clip !== undefined) {
      if (clip.played && this.followOf(moment) === null) this.host.refilmStage(clipID, clip);
      return;
    }
    const parent = moment.parentKey === null ? null : this.tree.get(moment.parentKey);
    if (parent?.held == null) return;
    if (clipID !== null) this.popClip(clipID, moment, "refilm");
    moment.clipID = null;
    moment.clipURL = null;
    moment.clip = null;
    moment.held = null;
    moment.boxes = null;
    moment.checks = null;
    const slot = this.host.pool.idle(this.host.activeSlot());
    record("refilm", { key: moment.key, slot, clipID, background: true });
    void this.film(moment, slot, "pinned", { pinned: parent.held });
  }
}
