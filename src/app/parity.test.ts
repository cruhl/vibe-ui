import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { MomentTree, newMoment } from "../moments/index.ts";
import { readRoute } from "../route/index.ts";
import { folderScenarios } from "../scenario/index.ts";
import { Keeper, type KeeperHost } from "./keeper.ts";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Every file that decides what a run films, writes, captures, boxes, checks, prunes or plays. */
const engine = [
  "src/app/ahead.ts",
  "src/app/controller.ts",
  "src/app/stage-boxes.ts",
  "src/app/clips.ts",
  "src/app/local-players.ts",
  "src/app/frames.ts",
  "src/app/lock.ts",
  "src/moments/schedule.ts",
  "src/moments/tree.ts",
  "src/moments/moment.ts",
  "src/moments/record.ts",
];

/** What the engine may ask of the keeper: the only places a bake and a live run differ. */
const keeperCalls = new Set(["start", "load", "keep", "full", "stop"]);

describe("a bake is the live engine recorded", () => {
  test("no engine file branches on the kind of run", () => {
    const branches = engine.flatMap((path) =>
      read(path)
        .split("\n")
        .flatMap((line, index) =>
          /BakeMode|\.mode\b|route\.bake|origin\s*[!=]==|keepsWritten|overCap|"check"/.test(line) &&
          !line.includes("new Keeper(this.route.bake,")
            ? [`${path}:${String(index + 1)}: ${line.trim()}`]
            : [],
        ),
    );
    expect(branches).toEqual([]);
  });

  test("the run's kind reaches the engine once, as its keeper, used only through its seam", () => {
    const controller = read("src/app/controller.ts");
    expect(controller.match(/route\.bake/g)).toHaveLength(1);
    expect(controller.match(/new Keeper\(/g)).toHaveLength(1);
    expect(controller.match(/new Ahead\(/g)).toHaveLength(1);
    const used = engine.flatMap((path) =>
      [...read(path).matchAll(/\bkeeper\.(\w+)\(/g)].map((match) => match[1] ?? ""),
    );
    expect(used.filter((name) => !keeperCalls.has(name))).toEqual([]);
    for (const path of engine.filter((file) => file !== "src/app/controller.ts"))
      expect(read(path)).not.toMatch(/from "\.\/keeper\.ts"/);
  });

  test("a bake reads the same knobs as a live run; only where it keeps and how much differ", () => {
    const live = readRoute("?preset=a&depth=3&write=4&guesses=3&pool=6");
    const bake = readRoute("?preset=a&depth=3&write=4&guesses=3&pool=6&bake=1&bakeCap=30");
    expect(bake.knobs).toEqual(live.knobs);
    expect({ ...bake, bake: null }).toEqual(live);
    expect(bake.bake).toEqual({ mode: "bake", capBytes: 30_000_000 });
  });

  test("every kind of run keeps through the same calls; only a bake fills", async () => {
    const scenario = folderScenarios[0];
    if (scenario === undefined) throw new Error("no scenario folder");
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    const host: KeeperHost = {
      tree: () => new MomentTree(),
      busy: () => false,
      depths: { film: 1, write: 2 },
      hashes: () => ({ root: "r", instructions: "i", jevModel: "j" }),
      report: () => undefined,
    };
    const moment = newMoment(
      {
        key: "k",
        parentKey: null,
        input: null,
        index: 0,
        label: "start",
        lines: [],
        ops: [],
        world: scenario.world,
        state: scenario.initialView,
        beat: null,
        likelihood: null,
        memory: { input: "start", response: "" },
        prompt: "p",
      },
      null,
    );
    moment.status = "ready";
    moment.clip = new Blob([new Uint8Array(600)]);
    moment.held = new Blob([new Uint8Array(500)]);
    const live = new Keeper(null, scenario);
    const bake = new Keeper({ mode: "bake", capBytes: 1000 }, scenario);
    for (const keeper of [live, bake]) {
      expect(keeper.start(host)).toBe(true);
      expect(keeper.full()).toBe(false);
      keeper.keep(moment);
    }
    expect(live.full()).toBe(false);
    expect(bake.full()).toBe(true);
    await vi.waitFor(() => {
      expect(fetched.filter((url) => url.includes("name=k."))).toHaveLength(2);
    });
    for (const keeper of [live, bake]) keeper.stop();
    vi.unstubAllGlobals();
  });
});
