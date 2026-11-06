import { linesInstructions } from "../agent/index.ts";
import {
  checkTree,
  contentHash,
  momentRecord,
  rootKey,
  saveMoment,
  type BakedMoment,
  type BakeHashes,
  type Moment,
  type MomentKeeper,
  type MomentTree,
  type TreeCheck,
} from "../moments/index.ts";
import { openingPrompt } from "../projector/index.ts";
import { record, withDeadline } from "../run-log/index.ts";
import { scenarioFiles, type Scenario } from "../scenario/index.ts";
import type { BakeMode } from "../route/index.ts";
import type { BakeReport, BakeState } from "./state.ts";

/**
 * A saved tree as checked at load. The root's held frame is fetched before it opens; the others
 * follow nearest first, and `held` resolves each one as it lands, or null when it could not.
 */
export interface Saved {
  check: TreeCheck;
  held: (key: string) => Promise<Blob | null>;
}

/** What the run lends its keeper: the tree, whether work is under way, and where reports go. */
export interface KeeperHost {
  tree: () => MomentTree;
  /** Whether any moment is being written, captured or boxed. */
  busy: () => boolean;
  /** How far below the opening the run films and writes. */
  depths: { film: number; write: number };
  hashes: () => BakeHashes;
  report: (state: BakeState) => void;
}

const heldFetchMs = 5000;
/** Held frames fetched at once after the root's. */
const heldFetchesInFlight = 4;
const growthCheckMs = 1000;

/**
 * The hashes a saved tree must match: the root, the agent instructions (with how many guesses
 * each turn writes) and the Jev model.
 */
export function treeHashes(scenario: Scenario, guesses: number, jevModel: string): BakeHashes {
  return {
    root: rootKey(scenario.premise, JSON.stringify(scenario.world), openingPrompt(scenario.world)),
    instructions: contentHash(linesInstructions(scenario.premise, scenario.world, guesses)),
    jevModel,
  };
}

/**
 * Where a run's moments are kept, and how far the run grows: the one place a bake and a live
 * session differ. Every run loads the world's saved tree the same way and hands every moment that
 * turns ready to `keep`. A live run of a scenario folder keeps nothing; a live run of a written
 * scenario keeps each moment in this browser; a bake (the `bake` parameter) writes each one to
 * the scenario's folder through the dev endpoint as it turns ready, stops filming at its size cap
 * (`full`), and once the tree has grown to its depths writes `tree.json` and reports. With
 * `bake=check` it only checks the saved tree and the run grows nothing.
 */
export class Keeper implements MomentKeeper {
  /** Saved moments by key: those loaded, and once written, those of the tree as written. */
  private readonly records = new Map<string, BakedMoment>();
  private host: KeeperHost | null = null;
  private bytes = 0;
  private capped = false;
  private kept = 0;
  private reboxed = 0;
  private loaded: TreeCheck | null = null;
  private phase: BakeState["phase"] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Every media write so far, in order; `tree.json` is written after the last one lands. */
  private writing: Promise<void> = Promise.resolve();
  private writeFailed: string | null = null;

  constructor(
    private readonly mode: BakeMode | null,
    private readonly scenario: Scenario,
  ) {}

  /**
   * Starts keeping for a run. Returns false when the run grows nothing (`bake=check`), after
   * reporting what is stale in the saved tree.
   */
  start(host: KeeperHost): boolean {
    this.host = host;
    if (this.mode?.mode === "check") {
      const check = this.check(host.hashes());
      for (const { record: saved } of check?.moments ?? []) this.records.set(saved.key, saved);
      this.report("done", this.summary(check, null));
      return false;
    }
    if (this.mode === null) return true;
    this.report("loading", null);
    this.timer = setInterval(() => {
      this.checkGrown();
    }, growthCheckMs);
    return true;
  }

  /** Stops watching the run; nothing more is written. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Loads the saved tree when it holds: fetches the held frames of its filmed moments, within a
   * deadline. A live run serves a tree whose agent instructions changed, marked behind; a bake
   * rewrites it from the opening. A stale or missing tree means the live opening.
   */
  async load(hashes: BakeHashes): Promise<Saved | null> {
    const saved = await this.read(hashes);
    if (this.mode !== null && this.scenario.origin === "written") await this.writeFolder();
    if (this.mode !== null) this.report("baking", null);
    return saved;
  }

  /**
   * Keeps a moment that just turned ready: filmed, captured, boxed and checked. A loaded moment
   * boxed again keeps its media and only counts as reboxed.
   */
  keep(moment: Moment): void {
    const clip = moment.clip;
    const held = moment.held;
    if (moment.baked) {
      this.reboxed++;
      return;
    }
    if (clip === null || held === null) return;
    this.kept++;
    if (this.mode === null) {
      if (this.scenario.origin === "written") this.saveInBrowser(moment, clip, held);
      return;
    }
    this.bytes += clip.size + held.size;
    this.writing = this.writing.then(async () => {
      try {
        await this.post(`${moment.key}.mp4`, clip, "moments");
        await this.post(`${moment.key}.jpg`, held, "moments");
      } catch (error: unknown) {
        this.writeFailed = String(error);
        record("bake_failed", { key: moment.key, message: String(error) });
      }
    });
  }

  /** Whether the run has filmed all it keeps: a bake past its size cap. Logs it once. */
  full(): boolean {
    const capped = this.mode !== null && this.bytes >= this.mode.capBytes;
    if (capped && !this.capped) record("bake_capped", { bytes: this.bytes });
    this.capped ||= capped;
    return capped;
  }

  private report(phase: BakeState["phase"], report: BakeReport | null): void {
    this.phase = phase;
    this.host?.report({ phase, report });
  }

  private saveInBrowser(moment: Moment, clip: Blob, held: Blob): void {
    const hashes = this.host?.hashes();
    if (hashes === undefined) return;
    void saveMoment(this.scenario.id, momentRecord(moment, clip.size), hashes, clip, held).then(
      () => {
        record("moment_saved", { key: moment.key, scenarioID: this.scenario.id });
      },
    );
  }

  /** Checks the world's saved tree against the world and code as they are now. */
  private check(hashes: BakeHashes): TreeCheck | null {
    const source = this.scenario.moments;
    if (source === null) return null;
    const check = checkTree(source.tree, this.scenario.world, hashes);
    record("baked_tree", {
      moments: check.moments.length,
      stale: check.stale,
      rootStale: check.rootStale,
      behind: check.behind,
      rebox: check.rebox,
    });
    return check;
  }

  private async read(hashes: BakeHashes): Promise<Saved | null> {
    const check = this.check(hashes);
    this.loaded = check;
    if (check === null || check.rootStale || (check.behind && this.mode !== null)) return null;
    const source = this.scenario.moments;
    if (source === null) return null;
    const fetchHeld = (baked: BakedMoment): Promise<Blob | null> => {
      const url = baked.held === null ? null : source.mediaURL(baked.held);
      if (url === null || baked.status !== "ready") return Promise.resolve(null);
      return withDeadline("baked_held", heldFetchMs, async (signal) => {
        const response = await fetch(url, { signal });
        return response.ok ? response.blob() : null;
      }).catch((error: unknown) => {
        record("baked_held_failed", { key: baked.key, message: String(error) });
        return null;
      });
    };
    const [first, ...rest] = check.moments.map((loaded) => loaded.record);
    if (first === undefined) return null;
    const rootHeld = await fetchHeld(first);
    if (rootHeld === null && first.status === "ready") {
      record("baked_load_failed", { message: "the opening's held frame did not load" });
      return null;
    }
    const fetches = new Map<string, Promise<Blob | null>>([[first.key, Promise.resolve(rootHeld)]]);
    const queue = this.nearestFirst(check, rest);
    const next = async (): Promise<void> => {
      const baked = queue.shift();
      if (baked === undefined) return;
      await fetchHeld(baked).then((held) => {
        resolvers.get(baked.key)?.(held);
      });
      return next();
    };
    const resolvers = new Map<string, (held: Blob | null) => void>();
    for (const baked of rest)
      fetches.set(
        baked.key,
        new Promise((resolve) => {
          resolvers.set(baked.key, resolve);
        }),
      );
    for (let i = 0; i < heldFetchesInFlight; i++) void next();
    for (const { record: baked } of check.moments) {
      this.records.set(baked.key, baked);
      if (baked.status === "ready") this.bytes += (baked.clipBytes ?? 0) + (baked.heldBytes ?? 0);
    }
    return { check, held: (key) => fetches.get(key) ?? Promise.resolve(null) };
  }

  /** Saved moments below the root, shallowest first and likeliest first within a depth. */
  private nearestFirst(check: TreeCheck, moments: readonly BakedMoment[]): BakedMoment[] {
    const depth = new Map<string, number>();
    for (const { record: baked } of check.moments)
      depth.set(baked.key, baked.parentKey === null ? 0 : (depth.get(baked.parentKey) ?? 0) + 1);
    return [...moments].sort(
      (first, second) =>
        (depth.get(first.key) ?? 0) - (depth.get(second.key) ?? 0) ||
        (second.likelihood ?? -1) - (first.likelihood ?? -1) ||
        first.index - second.index,
    );
  }

  private summary(check: TreeCheck | null, failed: string | null): BakeReport {
    return {
      scenario: this.scenario.id,
      stale: check?.stale ?? [],
      rootStale: check?.rootStale ?? false,
      behind: check?.behind ?? false,
      kept: [...this.records.values()].filter((item) => item.status === "ready").length,
      filmed: this.kept,
      written: 0,
      reboxed: this.reboxed,
      capped: this.capped,
      failed,
    };
  }

  private async post(name: string, body: Blob | string, place: "moments" | "folder") {
    const query = new URLSearchParams({
      scenario: this.scenario.id,
      name,
      ...(place === "folder" ? { place } : {}),
    });
    const response = await fetch(`/__dev/bake?${query.toString()}`, { method: "POST", body });
    if (!response.ok) throw new Error(`writing ${name} answered HTTP ${response.status}`);
  }

  /** A written scenario's own folder files, so its moments have a folder to land in. */
  private async writeFolder(): Promise<void> {
    const files = await scenarioFiles(this.scenario.id);
    for (const [path, blob] of files ?? [])
      if (!path.startsWith("moments/")) await this.post(path, blob, "folder");
    record("bake_folder_written", { scenario: this.scenario.id, files: files?.size ?? 0 });
  }

  /**
   * Whether the tree has grown as far as it will: every moment within the film depth is ready,
   * or rejected after its refilm, or left written at the size cap; every moment within the write
   * depth has its guesses written; and nothing is being captured, boxed or written.
   */
  private grown(tree: MomentTree, depths: KeeperHost["depths"], busy: boolean): boolean {
    if (tree.root === null || busy) return false;
    for (const moment of tree.all()) {
      const depth = tree.steps(moment) ?? 0;
      if (depth <= depths.film) {
        const settled =
          moment.status === "ready" ||
          (moment.status === "rejected" && moment.refilms > 0) ||
          (moment.status === "written" && (this.capped || moment.refilms > 0));
        if (!settled) return false;
      }
      if (depth < depths.write && moment.children !== "written") return false;
    }
    return true;
  }

  private checkGrown(): void {
    const host = this.host;
    if (host === null || this.phase !== "baking") return;
    if (!this.grown(host.tree(), host.depths, host.busy())) return;
    this.report("writing", null);
    void this.write(host.tree(), host.hashes()).then((state) => {
      this.stop();
      this.report(state.phase, state.report);
    });
  }

  /**
   * Writes `tree.json` once every media write has landed: every moment, parents first, unless
   * nothing in it changed. Resolves with the finished bake state.
   */
  private async write(tree: MomentTree, hashes: BakeHashes): Promise<BakeState> {
    await this.writing;
    const records = tree.all().map((moment) => {
      const ready = moment.status === "ready" && moment.held !== null;
      const clipBytes = moment.clip?.size ?? this.records.get(moment.key)?.clipBytes ?? null;
      return momentRecord(moment, ready ? clipBytes : null);
    });
    const written = tree.all().filter((moment) => !moment.baked && moment.status !== "ready");
    try {
      if (this.writeFailed !== null) throw new Error(this.writeFailed);
      const unchanged =
        this.kept === 0 &&
        written.length === 0 &&
        this.reboxed === 0 &&
        JSON.stringify([...this.records.values()]) === JSON.stringify(records);
      if (!unchanged)
        await this.post(
          "tree.json",
          JSON.stringify(
            {
              version: 1,
              scenario: this.scenario.id,
              bakedAt: new Date().toISOString(),
              hashes,
              moments: records,
            },
            null,
            2,
          ),
          "moments",
        );
      record("bake_written", {
        filmed: this.kept,
        written: written.length,
        unchanged,
        moments: records.length,
      });
      return {
        phase: "done",
        report: { ...this.summary(this.loaded, null), written: written.length },
      };
    } catch (error: unknown) {
      record("bake_failed", { message: String(error) });
      return {
        phase: "failed",
        report: { ...this.summary(this.loaded, String(error)), written: written.length },
      };
    }
  }
}
