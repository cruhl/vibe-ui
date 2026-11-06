import { describe, expect, test } from "vitest";
import { Draft } from "./draft.ts";
import { parseLine, viewLimits } from "./lines.ts";
import { worldFromFile, type Entity, type World } from "./world.ts";

const spots = Array.from({ length: 16 }, (_, index) => `spot.${String(index)}`);

const thing = (id: string, place: string, control: Entity["control"]): Entity => ({
  id,
  parent: place === "around" ? null : "room",
  place,
  look: `a plain ${id}`,
  state: null,
  words: null,
  control,
  sound: null,
  voice: null,
});

const roomWith = (picks: number, props = 0): World =>
  worldFromFile({
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
      places: Object.fromEntries(
        ["around", ...spots].map((place, order) => [place, { phrase: `At ${place}`, order }]),
      ),
      ladder: [{ mood: "calm", ambient: "hum", sound: "click" }],
      filler: [],
    },
    entities: [
      thing("room", "around", null),
      ...Array.from({ length: picks }, (_, index) =>
        thing(`pick-${String(index)}`, spots[index] ?? "", "pick"),
      ),
      ...Array.from({ length: props }, (_, index) =>
        thing(`prop-${String(index)}`, spots[picks + index] ?? "", null),
      ),
    ],
    facts: {},
  });

const push = (draft: Draft, line: string) => draft.push(line, parseLine(line));

describe("the ceiling on picks in view", () => {
  test("drops only the pick add that would go over the ceiling, with its reason kept", () => {
    const draft = new Draft(roomWith(viewLimits.picks), () => null, true);
    expect(push(draft, "~pick-0 spinning")).toBeNull();
    expect(push(draft, "+dragon room spot.12 pick | a red dragon")).toBeNull();
    expect(draft.crowded[0]).toContain(`over ${String(viewLimits.picks)}`);
    expect(draft.errors).toEqual([]);
    expect(draft.world.entities.dragon).toBeUndefined();
    expect(draft.lines).toEqual(["~pick-0 spinning"]);
  });

  test("lines about a dropped thing are dropped with it, never rejected", () => {
    const draft = new Draft(roomWith(viewLimits.picks), () => null, true);
    push(draft, "+dragon room spot.12 pick | a red dragon");
    expect(push(draft, "+egg dragon spot.13 | a gold egg")).toBeNull();
    expect(push(draft, "~dragon breathing fire")).toBeNull();
    expect(push(draft, "~egg cracking")).toBeNull();
    expect(draft.errors).toEqual([]);
    expect(draft.lines).toEqual([]);
  });

  test("an add fits once the agent removes what has played its part first", () => {
    const draft = new Draft(roomWith(viewLimits.picks), () => null, true);
    expect(push(draft, "-pick-3")).toBeNull();
    expect(push(draft, "+dragon room spot.12 pick | a red dragon")).toBeNull();
    expect(draft.crowded).toEqual([]);
    expect(draft.world.entities.dragon).toBeDefined();
  });

  test("props, fixtures and places never count", () => {
    const draft = new Draft(roomWith(viewLimits.picks, 6), () => null, true);
    expect(push(draft, "+window world spot.14 | a huge gold window")).toBeNull();
    expect(push(draft, "+smoke window spot.15 | a puff of grey smoke")).toBeNull();
    expect(draft.crowded).toEqual([]);
    expect(Object.keys(draft.world.entities)).toHaveLength(viewLimits.picks + 9);
  });

  test("an add that replaces what sits in its spot never counts as crowding", () => {
    const draft = new Draft(roomWith(viewLimits.picks), () => null, true);
    expect(push(draft, "+dragon room spot.0 pick | a red dragon")).toBeNull();
    expect(draft.crowded).toEqual([]);
  });

  test("a draft without the ceiling, as baked moments replay, keeps the add", () => {
    const draft = new Draft(roomWith(viewLimits.picks), () => null);
    expect(push(draft, "+dragon room spot.12 pick | a red dragon")).toBeNull();
    expect(draft.world.entities.dragon).toBeDefined();
  });
});
