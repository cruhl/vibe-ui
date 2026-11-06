import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ElementBox } from "../jev/index.ts";
import { MomentTree, newMoment, type Moment } from "../moments/index.ts";
import { getEvents } from "../run-log/index.ts";
import { folderScenarios } from "../scenario/index.ts";
import { Clips, type ClipRecord } from "./clips.ts";
import { StageBoxes, type StageBoxesHost } from "./stage-boxes.ts";
import { initialState, viewKey, type AppState } from "./state.ts";

vi.mock("../capture/index.ts", () => ({ captureFile: vi.fn() }));

const jev = vi.hoisted(() => {
  const answer: { answer: ((elementIDs: string[]) => ElementBox[]) | null } = { answer: null };
  return answer;
});

vi.mock("../jev/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../jev/index.ts")>();
  return {
    ...original,
    boxElements: vi.fn((_connection: unknown, _base64: string, elements: { id: string }[]) => {
      const answer = jev.answer;
      if (answer === null) return Promise.reject(new Error("jev down"));
      return Promise.resolve({
        boxes: answer(elements.map((element) => element.id)),
        likelihoods: null,
        degradation: null,
        inputTokens: 0,
        model: "jev-test",
        questions: {},
        answers: {},
      });
    }),
  };
});

const preset = folderScenarios.find((scenario) => scenario.id === "caveman-os");
if (preset === undefined) throw new Error("no caveman-os preset");
const scenario = preset;
const view = scenario.initialView;
const [introduced, ...kept] = view.elements.map((element) => element.id);
if (introduced === undefined) throw new Error("caveman-os shows nothing");

/** Jev's boxes for every element asked about, one per cell, each at the presence given. */
const boxesAt =
  (presence: (elementID: string) => number) =>
  (elementIDs: string[]): ElementBox[] =>
    elementIDs.map((elementID, index) => ({
      elementID,
      box: {
        top: 0,
        bottom: 0.05,
        left: index * 0.05,
        right: index * 0.05 + 0.04,
      },
      confidence: 1,
      presence: presence(elementID),
    }));

const shows = boxesAt(() => 0.9);
const missesIntroduced = boxesAt((elementID) => (elementID === introduced ? 0.1 : 0.9));

function moment(key: string): Moment {
  return newMoment(
    {
      key,
      parentKey: null,
      input: null,
      index: 0,
      label: "grunt",
      lines: [],
      ops: [],
      world: view.world,
      state: view,
      beat: null,
      likelihood: null,
      memory: { input: "grunt", response: "" },
      prompt: "p",
    },
    null,
  );
}

function clipOf(onStage: Moment | null, refilmOf: string | null): ClipRecord {
  return {
    slot: 0,
    inputID: "i1",
    moment: onStage,
    stateOf: () => view,
    built: true,
    popped: false,
    played: true,
    prompt: "p",
    introduced: [introduced ?? ""],
    removed: [],
    refilmOf,
    start: "pinned",
  };
}

/** A stage holding the clip `committed` on the root moment, with nothing playing. */
function stage(committed: string | null) {
  const tree = new MomentTree();
  const root = moment("root");
  tree.plant(root);
  const clips = new Clips((milliseconds, run) => {
    setTimeout(run, milliseconds);
  });
  let state: AppState = {
    ...initialState(scenario),
    phase: "running",
    firstFrames: 2,
    shownView: view,
    view,
  };
  const refilms: string[] = [];
  const world: { committed: string | null; playing: boolean; boxing: Promise<void> | undefined } = {
    committed,
    playing: false,
    boxing: undefined,
  };
  const host: StageBoxesHost = {
    clips,
    ahead: {
      tree,
      boxingOf: () => world.boxing,
      openGuesses: () => [],
      rankedCount: 0,
      applyLikelihoods: () => undefined,
    },
    memory: { tail: () => [] },
    state: () => state,
    set: (partial) => {
      state = { ...state, ...partial };
    },
    frame: () => ({ base64: "aGVsZA==", width: 16, height: 9, luma: 90 }),
    keys: () => ({ reactor: "", openAI: "", typesafe: "", fal: "", hosted: false }),
    committed: () => world.committed,
    settled: () => true,
    playing: () => world.playing,
    showClipState: () => undefined,
    captureHeld: () => undefined,
    saveFrame: () => undefined,
    markInput: () => undefined,
    updateInput: () => undefined,
    retryUnresolved: () => undefined,
    refilm: (clipID) => {
      refilms.push(clipID);
    },
  };
  return { boxes: new StageBoxes(host), root, clips, world, refilms, state: () => state };
}

const open = (state: AppState) =>
  state.heldReady && state.locked === null && state.boxesKey === viewKey(state.shownView);

describe("input reopens on every held frame", () => {
  beforeEach(() => {
    jev.answer = shows;
  });

  test("a moment rejected by its checks still opens input when it holds, while it is refilmed", async () => {
    const { boxes, root, clips, state } = stage("original");
    root.clipID = "original";
    root.status = "rejected";
    root.boxes = shows(view.elements.map((element) => element.id));
    clips.set("original", clipOf(root, null));
    await boxes.hold(root);
    expect(open(state())).toBe(true);
    expect(state().boxes.length).toBe(view.elements.length);
  });

  test("the refilm, rejected again, opens input when it holds", async () => {
    const { boxes, root, clips, state } = stage("refilm");
    root.clipID = "refilm";
    root.status = "rejected";
    root.refilms = 1;
    root.boxes = shows(view.elements.map((element) => element.id));
    clips.set("original", clipOf(root, null));
    clips.set("refilm", clipOf(root, "original"));
    await boxes.hold(root);
    expect(open(state())).toBe(true);
  });

  test("a held frame that fails its check is refilmed once and opens input on its boxes", async () => {
    jev.answer = missesIntroduced;
    const { boxes, root, clips, refilms, state } = stage("original");
    clips.set("original", clipOf(root, null));
    await boxes.held("original");
    expect(refilms).toEqual(["original"]);
    expect(open(state())).toBe(true);
    expect(state().boxes.map((found) => found.elementID)).toEqual(expect.arrayContaining(kept));
    expect(getEvents().some((event) => event.kind === "frame_mismatch")).toBe(true);
  });

  test("a refilm whose held frame fails again is not refilmed and opens input", async () => {
    jev.answer = missesIntroduced;
    const { boxes, root, clips, refilms, state } = stage("refilm");
    clips.set("original", clipOf(root, null));
    clips.set("refilm", clipOf(root, "original"));
    await boxes.held("refilm");
    expect(refilms).toEqual([]);
    expect(open(state())).toBe(true);
  });

  test("the original's held frame opens input while its refilm is still being built", async () => {
    jev.answer = missesIntroduced;
    const { boxes, root, clips, refilms, state } = stage("refilm");
    clips.set("original", clipOf(root, null));
    clips.set("refilm", clipOf(root, "original"));
    expect(boxes.onStage("original")).toBe(true);
    await boxes.held("original");
    expect(refilms).toEqual([]);
    expect(open(state())).toBe(true);
  });

  test("a held frame Jev cannot box opens input unchecked, every click a point", async () => {
    jev.answer = null;
    const { boxes, root, clips, refilms, state } = stage("original");
    clips.set("original", clipOf(root, null));
    await boxes.held("original");
    expect(refilms).toEqual([]);
    expect(open(state())).toBe(true);
    expect(state().boxes).toEqual([]);
  });

  test("a held frame superseded by a newer answer leaves input to that answer", async () => {
    const { boxes, root, clips, world, state } = stage("original");
    clips.set("original", clipOf(root, null));
    world.committed = "newer";
    await boxes.held("original");
    expect(state().heldReady).toBe(false);
  });

  test("a failed answer reopens input on the held frame once nothing plays", () => {
    const { boxes, world, state } = stage("answer");
    world.playing = true;
    expect(boxes.reopen("lock_deadline")).toBe(false);
    world.playing = false;
    expect(boxes.reopen("lock_deadline")).toBe(true);
    expect(open(state())).toBe(true);
  });

  test("input stays shut while an input is being answered, and before the first frame", () => {
    const locked = stage("answer");
    locked.state().locked = "i2";
    expect(locked.boxes.reopen("build_stall")).toBe(false);
    expect(locked.state().heldReady).toBe(false);
    const opening = stage(null);
    opening.state().firstFrames = 0;
    expect(opening.boxes.reopen("enqueue_refused")).toBe(false);
  });
});
