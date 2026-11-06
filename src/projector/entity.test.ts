import { describe, expect, test } from "vitest";
import { folderScenarios } from "../scenario/index.ts";
import { applyOp, hashWorld, parseLine, type Op, type World } from "../state/index.ts";
import {
  describeChange,
  estimateTokens,
  forbiddenWord,
  projectEntity,
  promptBand,
  viewOf,
} from "./entity.ts";

function run(world: World, lines: readonly string[]): { world: World; ops: Op[] } {
  let current = world;
  const ops: Op[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed.ok) throw new Error(parsed.error);
    const applied = applyOp(current, parsed.op);
    if (!applied.ok) throw new Error(applied.error);
    current = applied.world;
    ops.push(parsed.op);
  }
  return { world: current, ops };
}

const openFire = [
  "+fire-window world center | a window of tan animal hide in a wooden frame with a bark title bar | FIRE.EXE",
  "+fire-close fire-window title.right pick | a small bone button | X",
  "+hearth fire-window body.top | a shallow ring of grey stones | | holding cold grey ash",
  "+make-fire fire-window body.middle pick | a big rounded stone tablet button | MAKE FIRE",
  "+counter fire-window body.bottom | a small bark plaque | FIRES $fires",
];

const fireClick = { kind: "click", elementID: "fire", label: "FIRE" } as const;

describe.each(folderScenarios.map((preset) => [preset.id, preset] as const))(
  "preset %s",
  (_id, preset) => {
    test("projects every state in band with no forbidden words", () => {
      const start = projectEntity(preset.world, { kind: "start" }, preset.world, []);
      expect(forbiddenWord(start.prompt)).toBeNull();
      expect(start.tokens).toBeGreaterThanOrEqual(promptBand.min);
      expect(start.tokens).toBeLessThanOrEqual(promptBand.max);
      expect(start.prompt).not.toMatch(/[‐-―-]|"/);
      expect(start.prompt.split("\n\n").map((part) => part.split(":")[0])).toEqual([
        "integrated_multimodal_description",
        "overall_soundscape",
        "non_diegetic_music",
      ]);
      for (const rung of preset.world.canon.ladder)
        expect(forbiddenWord(`${rung.ambient} ${rung.sound}`)).toBeNull();
      expect(start.prompt.toLowerCase()).toContain(`${preset.world.canon.style.toLowerCase()}.`);
    });

    test("every clickable entity becomes an element with a label", () => {
      const view = viewOf(preset.world);
      expect(view.elements.length).toBeGreaterThanOrEqual(2);
      for (const element of view.elements) expect(element.label).not.toBe("");
    });
  },
);

describe("caveman entity projection", () => {
  const desktop = folderScenarios.find((preset) => preset.id === "caveman-os")?.world;
  if (desktop === undefined) throw new Error("no caveman preset");

  test("a fact named in a state prints its value, never its key", () => {
    const { world, ops } = run(desktop, [
      ...openFire,
      "=fires 3",
      "~hearth glowing beside a tally of $fires",
    ]);
    const prompt = projectEntity(world, fireClick, desktop, ops).prompt;
    expect(prompt).toContain("glowing beside a tally of 3");
    expect(prompt).not.toContain("$fires");
  });

  test("a pick narrates the window opening through the canon and walks the whole world", () => {
    const { world, ops } = run(desktop, openFire);
    const projection = projectEntity(world, fireClick, desktop, ops);
    expect(projection.prompt).toContain("bearing the word FIRE.");
    expect(projection.prompt).toContain(
      "and right away a window of tan animal hide in a wooden frame with a bark title bar",
    );
    expect(projection.prompt).toContain("bearing the words FIRES 0.");
    expect(projection.prompt).toContain(`Every printed word is set in ${desktop.canon.lettering},`);
    expect(projection.tokens).toBeLessThanOrEqual(promptBand.max);
    expect(forbiddenWord(projection.prompt)).toBeNull();
  });

  test("a counter press narrates the change and fills the fact", () => {
    const open = run(desktop, openFire).world;
    const { world, ops } = run(open, [
      "~hearth holding one small crackling orange flame",
      "=fires 1",
      "! the flame turns toward the camera and gives one small proud bow",
    ]);
    const prompt = projectEntity(
      world,
      { kind: "click", elementID: "make-fire", label: "MAKE FIRE" },
      open,
      ops,
    ).prompt;
    expect(prompt).toContain(
      "the shallow ring of grey stones springs into motion and ends up holding one small crackling orange flame, and then the small bark plaque flips over to read FIRES 1",
    );
    expect(prompt).toContain(
      "Through the middle of the clip, with everything in lively motion, the flame turns toward the camera",
    );
  });

  test("one input narrates every change and beat in order, then the settle", () => {
    const open = run(desktop, openFire).world;
    const { world, ops } = run(open, [
      "~hearth holding a roaring orange bonfire",
      "+elder world right.top pick | a stooped old caveman in a fur cloak | | dancing | a slow gravelly old voice",
      "=fires 1",
      "! sparks shoot up and swirl around the window",
      "! the elder stomps a happy dance",
      "%elder Fire big.",
    ]);
    const prompt = projectEntity(
      world,
      { kind: "click", elementID: "make-fire", label: "MAKE FIRE" },
      open,
      ops,
    ).prompt;
    const order = [
      "and right away the shallow ring of grey stones springs into motion",
      ", then a stooped old caveman in a fur cloak",
      ", and then the small bark plaque flips over to read FIRES 1",
      "the clip, with everything in lively motion, sparks shoot up and swirl around the window, and then the elder stomps a happy dance.",
      desktop.canon.settle,
    ].map((part) => prompt.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((first, second) => first - second)).toEqual(order);
    expect(forbiddenWord(prompt)).toBeNull();
  });

  test("the progress line names the first change", () => {
    const { world, ops } = run(desktop, openFire);
    expect(describeChange(desktop, world, ops)).toMatch(/^A window of tan animal hide/);
  });

  test("a thing added in a taken place replaces the one there with its insides", () => {
    const open = run(desktop, openFire).world;
    const { world, ops } = run(open, ["+rock-window world center | a window of hide | ROCK.EXE"]);
    expect(world.entities["rock-window"]?.place).toBe("center");
    expect(world.entities["fire-window"]).toBeUndefined();
    expect(world.entities["make-fire"]).toBeUndefined();
    expect(world.registry["make-fire"]?.parent).toBe("fire-window");
    const back = run(world, ["+fire-window", "+make-fire"]).world;
    expect(back.entities["rock-window"]).toBeUndefined();
    expect(back.entities["make-fire"]?.place).toBe("body.middle");
    expect(projectEntity(world, fireClick, open, ops).prompt).toContain("a window of hide");
  });

  test("a remove line keeps only its id", () => {
    const parsed = parseLine("-fire-window world center | a window");
    expect(parsed.ok && parsed.op.op === "remove" ? parsed.op.id : null).toBe("fire-window");
  });

  test("closing the window returns to the starting hash", () => {
    const open = run(desktop, openFire).world;
    expect(hashWorld(open)).not.toBe(hashWorld(desktop));
    const closed = run(open, ["=fires 1", "-fire-window"]).world;
    expect(hashWorld(closed)).toBe(hashWorld(desktop));
    expect(Object.keys(closed.entities)).toHaveLength(Object.keys(desktop.entities).length);
  });

  test("a removed thing comes back by id with its stored look, never a new one", () => {
    const closed = run(run(desktop, openFire).world, ["-fire-window"]).world;
    const relook = parseLine("+fire-window world center | a window of bright pink silk | FIRE.EXE");
    if (!relook.ok) throw new Error(relook.error);
    const rejected = applyOp(closed, relook.op);
    expect(rejected.ok ? null : rejected.error).toMatch(/already known/);
    const same = parseLine(
      "+fire-window world center | A window of tan animal hide in a wooden frame with a bark title bar.",
    );
    if (!same.ok) throw new Error(same.error);
    expect(applyOp(closed, same.op).ok).toBe(true);
    const { world, ops } = run(closed, [
      "+fire-window",
      "+fire-close",
      "+make-fire fire-window body.middle",
    ]);
    expect(world.entities["fire-close"]?.place).toBe("title.right");
    expect(world.entities["fire-window"]?.look).toMatch(/^a window of tan animal hide/);
    expect(world.entities["fire-window"]?.words).toBe("FIRE.EXE");
    expect(world.entities["make-fire"]?.control).toBe("pick");
    const prompt = projectEntity(world, fireClick, closed, ops).prompt;
    expect(prompt).toContain(
      "In the center of the screen, clear of the icon column, with a margin of stone wallpaper on every side, a window of tan animal hide",
    );
  });

  test("a new thing needs a look, and only a voiced thing speaks", () => {
    const bare = parseLine("+ghost world right.top pick");
    if (!bare.ok) throw new Error(bare.error);
    expect(applyOp(desktop, bare.op).ok).toBe(false);
    const { world, ops } = run(desktop, [
      "+elder world right.top pick | a stooped old caveman in a fur cloak | | | a slow gravelly old voice",
      "%elder Fire good. Fire warm.",
    ]);
    const prompt = projectEntity(world, fireClick, desktop, ops).prompt;
    expect(prompt).toContain(
      "A slow gravelly old voice, the voice of the stooped old caveman in a fur cloak, says Fire good. Fire warm.",
    );
    const mute = parseLine("%fire hello there");
    if (!mute.ok) throw new Error(mute.error);
    expect(applyOp(world, mute.op).ok).toBe(false);
  });

  test("unknown ids, places and gags are rejected", () => {
    for (const line of [
      "~ghost glowing",
      "+thing world nowhere | a rock",
      "*bow",
      "-ghost",
      "+hearth world right.top | a stone hearth | holding a modest orange flame",
      "~start | A VERY LONG PRINTED LABEL",
    ]) {
      const parsed = parseLine(line);
      expect(parsed.ok && applyOp(desktop, parsed.op).ok).toBe(false);
    }
  });

  test("the projected prompt is byte stable", () => {
    const { world, ops } = run(desktop, openFire);
    expect(projectEntity(world, fireClick, desktop, ops).prompt).toBe(
      projectEntity(world, fireClick, desktop, ops).prompt,
    );
    expect(estimateTokens("abcd")).toBe(1);
  });
});
