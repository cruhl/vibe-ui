import { describe, expect, test } from "vitest";
import { applyOp, formatEntity, lineLimits, parseLine, unresolvedFacts, type Op } from "./lines.ts";
import { worldFromFile, type Entity, type World } from "./world.ts";

const thing = (entity: Partial<Entity> & Pick<Entity, "id" | "place" | "look">): Entity => ({
  parent: null,
  state: null,
  words: null,
  control: null,
  sound: null,
  voice: null,
  ...entity,
});

const world: World = worldFromFile({
  canon: {
    name: "a test room",
    frame: "a still camera",
    still: "nothing moves",
    approach: "{thing} comes closer",
    arrive: "{thing} appears",
    leave: "{thing} leaves",
    settle: "everything rests",
    ambient: "a quiet hum",
    selectSound: "a click",
    lettering: "bold capitals",
    style: "flat bright gouache paint",
    places: {
      left: { phrase: "On the left", order: 0 },
      right: { phrase: "On the right", order: 1 },
      inside: { phrase: "Inside it", order: 2 },
    },
    ladder: [
      { mood: "calm", ambient: "hum", sound: "click" },
      { mood: "wild", ambient: "roar", sound: "bang" },
    ],
    filler: [],
  },
  entities: [
    thing({ id: "box", place: "left", look: "a red wooden box", control: "pick", words: "OPEN" }),
    thing({ id: "toy", parent: "box", place: "inside", look: "a tin robot", voice: "a buzz" }),
  ],
  facts: { count: "0" },
});

function op(line: string): Op {
  const parsed = parseLine(line);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.op;
}

function apply(start: World, ...lines: string[]): World {
  return lines.reduce((current, line) => {
    const applied = applyOp(current, op(line));
    if (!applied.ok) throw new Error(`${line}: ${applied.error}`);
    return applied.world;
  }, start);
}

const rejection = (start: World, line: string) => {
  const applied = applyOp(start, op(line));
  return applied.ok ? null : applied.error;
};

describe("parseLine", () => {
  test("reads every sigil of the line format", () => {
    expect(op("~box lid open | SHUT")).toEqual({
      op: "change",
      id: "box",
      state: "lid open",
      words: "SHUT",
    });
    expect(op("~box | SHUT")).toEqual({ op: "change", id: "box", state: null, words: "SHUT" });
    expect(op("~box lid open")).toEqual({
      op: "change",
      id: "box",
      state: "lid open",
      words: undefined,
    });
    expect(op("=count 3")).toEqual({ op: "fact", key: "count", value: "3" });
    expect(op("-box")).toEqual({ op: "remove", id: "box" });
    expect(op("! the lid flies off")).toEqual({
      op: "beat",
      name: null,
      text: "the lid flies off",
    });
    expect(op("!pop the lid flies off")).toEqual({
      op: "beat",
      name: "pop",
      text: "the lid flies off",
    });
    expect(op("^")).toEqual({ op: "climb" });
    expect(op("*pop")).toEqual({ op: "gag", name: "pop" });
    expect(op("> a spring boings")).toEqual({ op: "sound", text: "a spring boings" });
    expect(op("%toy hello there")).toEqual({ op: "say", id: "toy", text: "hello there" });
    expect(op("? box 0.7")).toEqual({ op: "guess", elementID: "box", likelihood: 0.7 });
    expect(op("? box")).toEqual({ op: "guess", elementID: "box", likelihood: null });
  });

  test("reads a full add, and leaves unwritten parts of a bare one to the registry", () => {
    expect(op("+lamp world right pick | a brass lamp | ON | glowing | a hiss")).toEqual({
      op: "add",
      placement: {
        id: "lamp",
        parent: null,
        place: "right",
        control: "pick",
        look: "a brass lamp",
        words: "ON",
        state: "glowing",
        voice: "a hiss",
      },
    });
    expect(op("+toy")).toEqual({
      op: "add",
      placement: {
        id: "toy",
        parent: undefined,
        place: undefined,
        control: null,
        look: null,
        words: null,
        state: null,
        voice: null,
      },
    });
  });

  test("rejects malformed lines with a reason", () => {
    for (const line of ["~", "=count", "+", "-", "!", "^ up", "*", "* two names", "%toy", ">"])
      expect(parseLine(line).ok, line).toBe(false);
    expect(parseLine("+lamp world right grab | a lamp")).toEqual({
      ok: false,
      error: "control must be pick or input, not grab",
    });
    expect(parseLine("hello")).toEqual({ ok: false, error: "unknown line: hello" });
  });
});

describe("applyOp", () => {
  test("never mutates the world it is given", () => {
    const before = JSON.stringify(world);
    apply(world, "~box lid open", "=count 2", "-box", "^");
    expect(JSON.stringify(world)).toBe(before);
  });

  test("a change keeps what it leaves out", () => {
    const changed = apply(world, "~box lid open");
    expect(changed.entities.box).toMatchObject({ state: "lid open", words: "OPEN" });
    expect(apply(changed, "~box | SHUT").entities.box).toMatchObject({
      state: "lid open",
      words: "SHUT",
    });
  });

  test("removing a thing takes everything inside it, and both come back as they were", () => {
    const removed = apply(world, "~toy waving", "-box");
    expect(Object.keys(removed.entities)).toEqual([]);
    expect(removed.order).toEqual([]);
    const back = apply(removed, "+box", "+toy");
    expect(back.entities.box).toEqual(world.entities.box);
    expect(back.entities.toy).toMatchObject({ parent: "box", place: "inside", state: "waving" });
  });

  test("a known thing keeps its look; a new one must bring one", () => {
    const removed = apply(world, "-box");
    expect(rejection(removed, "+box world left | a blue box")).toBe(
      "box is already known; bring it back with +box and no look",
    );
    expect(rejection(world, "+lamp world right")).toBe("lamp is new and needs a look");
    expect(rejection(world, "+Lamp world right | a lamp")).toBe("bad id Lamp");
  });

  test("a thing added where another sits replaces it and everything inside it", () => {
    const replaced = apply(world, "+lamp world left | a brass lamp");
    expect(Object.keys(replaced.entities)).toEqual(["lamp"]);
    expect(replaced.registry.toy).toMatchObject({ parent: "box", place: "inside" });
  });

  test("rejects unknown ids, parents, places and gags, and the top rung", () => {
    expect(rejection(world, "~ghost floating")).toBe("unknown id ghost");
    expect(rejection(world, "-ghost")).toBe("unknown id ghost");
    expect(rejection(world, "+lamp ghost left | a lamp")).toBe("unknown parent ghost");
    expect(rejection(world, "+lamp world attic | a lamp")).toBe("unknown place attic");
    expect(rejection(world, "*pop")).toBe("unknown gag pop");
    expect(rejection(apply(world, "^"), "^")).toBe("already on the top rung");
    expect(rejection(world, "? box 0.5")).toBe("a guess header is not a change");
  });

  test("enforces the word limits the agent's prompt states", () => {
    const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");
    expect(rejection(world, `! ${words(lineLimits.beat)}`)).toBeNull();
    expect(rejection(world, `! ${words(lineLimits.beat + 1)}`)).toBe(
      `beat over ${lineLimits.beat} words`,
    );
    expect(rejection(world, `%toy ${words(lineLimits.say + 1)}`)).toBe(
      `spoken words over ${lineLimits.say} words`,
    );
    expect(rejection(world, `+lamp world right | ${words(lineLimits.look + 1)}`)).toBe(
      `look over ${lineLimits.look} words`,
    );
    expect(rejection(world, "~box | A B C D E")).toBe(
      `printed words over ${lineLimits.printed} words`,
    );
    expect(rejection(world, "~box | awaiting its first spark")).toBe(
      "printed words must start with a capital letter or a digit",
    );
    expect(rejection(world, "~box | COUNT $count")).toBeNull();
    expect(rejection(world, "~box | Recycle Bin")).toBeNull();
    expect(rejection(world, "~box | 25 cents")).toBeNull();
  });

  test("only a thing with a voice speaks, and a named beat becomes a gag", () => {
    expect(rejection(world, "%box hello")).toBe("box has no voice");
    expect(apply(world, "!pop the lid flies off").gags).toEqual({ pop: "the lid flies off" });
  });
});

describe("the world as the agent reads it", () => {
  test("an entity prints in the syntax the agent writes, and parses back to the same thing", () => {
    const toy = world.entities.toy;
    if (toy === undefined) throw new Error("the test world has a toy");
    const line = formatEntity(toy);
    expect(line).toBe("+toy box inside | a tin robot |  |  | a buzz");
    const removed = apply(world, "-toy");
    expect(apply(removed, line).entities.toy).toEqual(toy);
  });

  test("names printed facts that nothing defines", () => {
    expect(unresolvedFacts(apply(world, "~box | COUNT $count"))).toEqual([]);
    expect(unresolvedFacts(apply(world, "~box | SCORE $score"))).toEqual(["score"]);
  });
});
