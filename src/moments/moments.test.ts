import { describe, expect, test } from "vitest";
import { folderScenarios } from "../scenario/index.ts";
import {
  answers,
  byLikelihood,
  contentHash,
  isFollow,
  momentKey,
  nextInput,
  rootKey,
  type Moment,
  type MomentInput,
  type MomentStatus,
} from "./moment.ts";
import { reserveSession, schedule, type NodeView, type SessionView } from "./schedule.ts";
import { MomentTree } from "./tree.ts";

const first = folderScenarios[0];
if (first === undefined) throw new Error("no scenario folder");
const { world, initialView } = first;

const click = (elementID: string): MomentInput => ({ elementID, action: "click", text: null });

function moment(
  key: string,
  parentKey: string | null,
  input: MomentInput | null,
  likelihood: number | null = null,
  index = 0,
): Moment {
  return {
    key,
    parentKey,
    input,
    index,
    label: input?.elementID ?? "start",
    lines: [],
    ops: [],
    world,
    state: initialView,
    beat: null,
    likelihood,
    memory: { input: "", response: "" },
    prompt: "p",
    status: "written",
    start: null,
    clipID: null,
    slot: null,
    clipURL: null,
    clip: null,
    held: null,
    boxes: null,
    checks: null,
    children: "none",
    baked: false,
    introduced: [],
    removed: [],
    abort: new AbortController(),
    refilms: 0,
  };
}

describe("moment keys", () => {
  test("are stable, and change with the parent, the input or any line", () => {
    const base = momentKey("root", click("door"), ["+ghost"]);
    expect(momentKey("root", click("door"), ["+ghost"])).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(momentKey("other", click("door"), ["+ghost"])).not.toBe(base);
    expect(momentKey("root", click("window"), ["+ghost"])).not.toBe(base);
    expect(momentKey("root", click("door"), ["+ghost", "!boo"])).not.toBe(base);
    expect(momentKey("root", click("door"), ["+gho", "st"])).not.toBe(base);
    expect(rootKey("a", "b", "c")).not.toBe(rootKey("a", "b", "d"));
    expect(contentHash("ab", "c")).not.toBe(contentHash("a", "bc"));
  });

  test("an input matches by element and action, typing by text", () => {
    const typed = moment("t", "r", { elementID: "name", action: "type", text: "Grog" });
    expect(answers(typed, { elementID: "name", action: "type", text: " grog " })).toBe(true);
    expect(answers(typed, { elementID: "name", action: "type", text: "Ugg" })).toBe(false);
    expect(answers(typed, click("name"))).toBe(false);
  });

  test("orders by likelihood with unscored last", () => {
    const ranked = byLikelihood([
      moment("a", "r", click("a"), 0.1, 0),
      moment("b", "r", click("b"), null, 1),
      moment("c", "r", click("c"), 0.7, 2),
    ]);
    expect(ranked.map((item) => item.key)).toEqual(["c", "a", "b"]);
  });
});

describe("the moment tree", () => {
  const build = () => {
    const tree = new MomentTree();
    const root = moment("root", null, null);
    tree.plant(root);
    const door = moment("door", "root", click("door"), 0.6, 0);
    const window = moment("window", "root", click("window"), 0.3, 1);
    const ghost = moment("ghost", "door", click("ghost"), 0.5, 0);
    const stairs = moment("stairs", "door", click("stairs"), null, 1);
    for (const node of [door, window, ghost, stairs]) expect(tree.add(node)).toBe(true);
    return { tree, root, door, window, ghost, stairs };
  };

  test("refuses an orphan, a repeated key and a second answer to the same input", () => {
    const { tree } = build();
    expect(tree.add(moment("lost", "nowhere", click("x")))).toBe(false);
    expect(tree.add(moment("door", "root", click("other")))).toBe(false);
    expect(tree.add(moment("door-2", "root", click("door")))).toBe(false);
  });

  test("finds the root's child for an input, depth and path probability", () => {
    const { tree, door, ghost, stairs } = build();
    expect(tree.findMatch(click("door"))).toBe(door);
    expect(tree.findMatch(click("ghost"))).toBeNull();
    expect(tree.depth(ghost)).toBe(2);
    expect(tree.pathProbability(ghost)).toBeCloseTo(0.3);
    expect(tree.pathProbability(stairs)).toBeCloseTo(0.3);
  });

  test("a follow-up answers no input and counts no step, and its chain re-roots onward", () => {
    const { tree, root, door } = build();
    const next = moment("next", "root", nextInput, 1);
    const then = moment("then", "next", nextInput, 1);
    const ghost = moment("chained-ghost", "then", click("ghost"), 0.5);
    for (const node of [next, then, ghost]) expect(tree.add(node)).toBe(true);
    expect(isFollow(next) && !isFollow(door)).toBe(true);
    expect(answers(next, click(""))).toBe(false);
    expect(tree.findMatch(click("ghost"))).toBeNull();
    expect([tree.depth(ghost), tree.steps(ghost), tree.steps(then)]).toEqual([3, 1, 0]);
    expect(
      tree
        .reRoot(next)
        .map((node) => node.key)
        .sort(),
    ).toEqual(["door", "ghost", "root", "stairs", "window"].sort());
    expect(tree.holds(root)).toBe(false);
    tree.reRoot(then);
    expect(tree.findMatch(click("ghost"))).toBe(ghost);
  });

  test("re-rooting prunes everything outside the new root's subtree", () => {
    const { tree, root, door, window, ghost, stairs } = build();
    const pruned = tree.reRoot(door);
    expect(pruned.map((node) => node.key).sort()).toEqual(["root", "window"]);
    expect(tree.root).toBe(door);
    expect(tree.holds(window)).toBe(false);
    expect(tree.holds(root)).toBe(false);
    expect(tree.depth(ghost)).toBe(1);
    expect(tree.findMatch(click("stairs"))).toBe(stairs);
    expect(tree.reRoot(window)).toEqual([]);
  });

  test("cutting removes a subtree but never the root", () => {
    const { tree, root, door } = build();
    expect(tree.cut(root)).toEqual([]);
    expect(tree.cut(door).map((node) => node.key)).toEqual(["door", "ghost", "stairs"]);
    expect(tree.children(root).map((node) => node.key)).toEqual(["window"]);
  });
});

const sessions = (outstanding: number[], reserved: number | null = null): SessionView[] =>
  outstanding.map((count, index) => ({
    index,
    ready: true,
    outstanding: count,
    reserved: index === reserved,
  }));

const view = (
  key: string,
  parentKey: string | null,
  depth: number,
  probability: number,
  index = 0,
  status: MomentStatus = "written",
  follow = false,
): NodeView => ({
  key,
  parentKey,
  depth,
  follow,
  probability,
  index,
  status,
  children: "written",
  refilms: 0,
});

describe("the scheduler", () => {
  const limits = { filmDepth: 2, writeDepth: 3, perSession: 2 };

  test("the likeliest child continues its parent on the builder, the rest pin elsewhere", () => {
    const plan = schedule(
      [
        view("root", null, 0, 1, 0, "ready"),
        view("a", "root", 1, 0.2, 0),
        view("b", "root", 1, 0.7, 1),
        view("c", "root", 1, 0.1, 2),
      ],
      [{ key: "root", retainedOn: 0, held: true }],
      sessions([1, 0, 0, 0], 3),
      limits,
    );
    expect(plan.film).toEqual([
      { key: "b", slot: 0, start: "latent" },
      { key: "a", slot: 1, start: "pinned" },
      { key: "c", slot: 2, start: "pinned" },
    ]);
  });

  test("the follow-up of the moment on stage continues it first, its guesses after it", () => {
    const plan = schedule(
      [
        view("root", null, 0, 1, 0, "ready"),
        { ...view("next", "root", 0, 1, 0, "written", true), children: "written" },
        view("a", "next", 1, 0.6, 0),
        view("b", "root", 1, 0.9, 0),
      ],
      [
        { key: "root", retainedOn: 0, held: true },
        { key: "next", retainedOn: null, held: false },
      ],
      sessions([0, 0]),
      { ...limits, perSession: 1 },
    );
    expect(plan.film).toEqual([
      { key: "next", slot: 0, start: "latent" },
      { key: "b", slot: 1, start: "pinned" },
    ]);
  });

  test("never passes a session's budget or touches the reserve", () => {
    const plan = schedule(
      [
        view("root", null, 0, 1, 0, "ready"),
        ...["a", "b", "c", "d", "e"].map((key, index) =>
          view(key, "root", 1, 0.5 - index * 0.05, index),
        ),
      ],
      [{ key: "root", retainedOn: null, held: true }],
      sessions([2, 1, 0], 2),
      limits,
    );
    expect(plan.film).toEqual([{ key: "a", slot: 1, start: "pinned" }]);
  });

  test("waits for a held frame when nothing can continue, and writes only near the stage", () => {
    const plan = schedule(
      [
        view("root", null, 0, 1, 0, "built"),
        { ...view("a", "root", 1, 0.5), children: "none" },
        { ...view("deep", "a", 3, 0.5), children: "none" },
      ],
      [{ key: "root", retainedOn: 0, held: false }],
      sessions([2, 0]),
      limits,
    );
    expect(plan.film).toEqual([]);
    expect(plan.write).toEqual(["a"]);
  });

  test("films nothing past the film depth or already refilmed", () => {
    const plan = schedule(
      [
        view("root", null, 0, 1, 0, "ready"),
        view("a", "root", 1, 0.9, 0, "ready"),
        view("aa", "a", 2, 0.5),
        view("aaa", "aa", 3, 0.5),
        { ...view("b", "root", 1, 0.05, 1), refilms: 1 },
      ],
      [
        { key: "root", retainedOn: null, held: true },
        { key: "a", retainedOn: null, held: true },
        { key: "aa", retainedOn: null, held: true },
      ],
      sessions([0, 0, 0]),
      limits,
    );
    expect(plan.film.map((order) => order.key)).toEqual(["aa"]);
  });

  test("keeps a reserve off the stage's session", () => {
    expect(reserveSession(sessions([0, 1, 0]), 0)).toBe(2);
    expect(reserveSession(sessions([0]), 0)).toBeNull();
  });
});

interface Build {
  key: string;
  remaining: number;
  dropped: boolean;
}

/**
 * A mock pool of five sessions under the scheduler: builds of 4 to 5 s, one at a time per
 * session, an agent that writes three guesses about 1.5 s after it is asked, and a person who
 * clicks about every 6 s, a guessed thing four times in five.
 */
describe("a simulated pool", () => {
  test("200 clicks: no refusal, no orphaned build, nothing sent after a prune", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const tick = 0.25;
    const perSession = 2;
    const limits = { filmDepth: 2, writeDepth: 3, perSession };
    const queues: Build[][] = [[], [], [], [], []];
    const builtOn = new Map<string, number>();
    const builtOrder: string[][] = [[], [], [], [], []];
    const writing = new Map<string, number>();
    const tree = new MomentTree();
    let counter = 0;
    const fresh = (
      parentKey: string | null,
      input: MomentInput | null,
      likelihood: number | null,
      index: number,
    ) => moment(`m${++counter}`, parentKey, input, likelihood, index);
    let root = fresh(null, null, null, 0);
    root.status = "filming";
    root.slot = 0;
    tree.plant(root);
    queues[0]?.push({ key: root.key, remaining: 3.3, dropped: false });
    let refusals = 0;
    let sentAfterPrune = 0;
    let clicks = 0;
    let hits = 0;
    let time = 0;
    let nextClick = 6;
    const outstanding = (index: number) => queues[index]?.length ?? 0;
    const prune = (nodes: readonly Moment[]) => {
      for (const node of nodes) {
        node.abort.abort();
        writing.delete(node.key);
        for (const queue of queues) {
          const at = queue.findIndex((item) => item.key === node.key && !item.dropped);
          if (at === -1) continue;
          if (at === 0) {
            const running = queue[0];
            if (running !== undefined) running.dropped = true;
          } else queue.splice(at, 1);
        }
      }
    };
    while (clicks < 200) {
      time += tick;
      for (const [index, queue] of queues.entries()) {
        const running = queue[0];
        if (running === undefined) continue;
        running.remaining -= tick;
        if (running.remaining > 0) continue;
        queue.shift();
        builtOrder[index]?.push(running.key);
        builtOn.set(running.key, index);
        const node = tree.get(running.key);
        if (!running.dropped && node !== null) node.status = "ready";
        if (node !== null) node.held = new Blob();
      }
      for (const [key, due] of [...writing]) {
        if (time < due) continue;
        writing.delete(key);
        const parent = tree.get(key);
        if (parent === null) continue;
        parent.children = "written";
        for (let index = 0; index < 3; index++)
          tree.add(fresh(key, click(`${key}-${index}`), 0.2 + random() * 0.5, index));
      }
      const reserve = reserveSession(
        queues.map((queue, index) => ({ index, ready: true, outstanding: queue.length })),
        tree.root?.slot ?? null,
      );
      const nodes = tree.all();
      const plan = schedule(
        nodes.flatMap((node) => {
          const depth = tree.depth(node);
          return depth === null
            ? []
            : [
                {
                  key: node.key,
                  parentKey: node.parentKey,
                  depth,
                  follow: false,
                  probability: tree.pathProbability(node),
                  index: node.index,
                  status: node.status,
                  children: node.children,
                  refilms: node.refilms,
                },
              ];
        }),
        nodes.map((node) => {
          const slot = builtOn.get(node.key);
          return {
            key: node.key,
            retainedOn:
              slot !== undefined && (builtOrder[slot] ?? []).slice(-8).includes(node.key)
                ? slot
                : null,
            held: node.held !== null,
          };
        }),
        queues.map((queue, index) => ({
          index,
          ready: true,
          outstanding: queue.length,
          reserved: index === reserve,
        })),
        limits,
      );
      for (const key of plan.write) {
        const node = tree.get(key);
        if (node === null) continue;
        node.children = "writing";
        writing.set(key, time + 1 + random());
      }
      for (const order of plan.film) {
        const node = tree.get(order.key);
        if (node === null) {
          sentAfterPrune++;
          continue;
        }
        if (outstanding(order.slot) >= perSession || order.slot === reserve) refusals++;
        node.status = "filming";
        node.slot = order.slot;
        queues[order.slot]?.push({
          key: node.key,
          remaining: order.start === "latent" ? 4.5 : 3.9,
          dropped: false,
        });
      }
      if (time < nextClick) continue;
      nextClick = time + 4 + random() * 4;
      clicks++;
      const current = tree.root;
      if (current === null) throw new Error("no root");
      const children = tree.children(current);
      const chosen = random() < 0.8 ? children[Math.floor(random() * children.length)] : undefined;
      if (chosen !== undefined) {
        hits++;
        prune(tree.reRoot(chosen));
        if (chosen.status === "written") {
          chosen.status = "filming";
          chosen.slot = reserve ?? 0;
          queues[chosen.slot]?.push({ key: chosen.key, remaining: 3.9, dropped: false });
        }
        root = chosen;
        continue;
      }
      for (const child of children) prune(tree.cut(child));
      const answer = fresh(current.key, click(`miss-${clicks}`), null, 9);
      tree.add(answer);
      prune(tree.reRoot(answer));
      answer.status = "filming";
      answer.slot = reserve ?? 0;
      answer.children = "writing";
      writing.set(answer.key, time + 2);
      if (outstanding(answer.slot) > perSession) refusals++;
      queues[answer.slot]?.push({ key: answer.key, remaining: 3.9, dropped: false });
      root = answer;
    }
    const orphaned = queues
      .flat()
      .filter((build) => !build.dropped && tree.get(build.key) === null).length;
    expect(refusals).toBe(0);
    expect(sentAfterPrune).toBe(0);
    expect(orphaned).toBe(0);
    expect(hits).toBeGreaterThan(120);
    expect(root).toBe(tree.root);
  });
});
