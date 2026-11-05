import { describe, expect, test } from "vitest";
import { readRoute } from "./route.ts";

describe("readRoute", () => {
  test("defaults with no parameters", () => {
    const route = readRoute("");
    expect(route).toMatchObject({
      scenario: null,
      keys: false,
      bake: null,
      pool: 5,
      omni: "real",
      jev: "real",
      eval: null,
    });
    expect(route.knobs).toMatchObject({ guesses: 3, depth: 2, write: 3, budget: 2 });
  });

  test("clamps numbers and reads a bake and an eval", () => {
    const route = readRoute(
      "?preset=a&pool=40&guesses=9&bake=check&bakeCap=4&omni=mock&mockFault=slow:1:3&eval=smoke&agent=replay&speed=0",
    );
    expect(route.scenario).toBe("a");
    expect(route.pool).toBe(8);
    expect(route.knobs.guesses).toBe(5);
    expect(route.knobs.depth).toBe(2);
    expect(route.bake).toEqual({ mode: "check", capBytes: 4_000_000 });
    expect(route.omni).toBe("mock");
    expect(route.mockFaults).toBe("slow:1:3");
    expect(route.eval).toMatchObject({ caseName: "smoke", agent: "replay", speed: 1 });
  });

  test("a replay kit runs on the stand-in Omni with stretched delays", () => {
    const route = readRoute("?kit=abc&delays=0.5");
    expect(route.kit).toBe("abc");
    expect(route.omni).toBe("mock");
    expect(route.delays).toBe(0.5);
    expect(readRoute("?delays=-2").delays).toBe(1);
  });
});
