import { describe, expect, test } from "vitest";
import { heldVerdict, momentChecks } from "./checks.ts";

const found = (elementID: string, presence: number) => ({
  elementID,
  box: { left: 0, top: 0, right: 0.5, bottom: 0.5 },
  confidence: null,
  presence,
});
const result = (boxes: ReturnType<typeof found>[], degradation: number | null) => ({
  boxes,
  likelihoods: null,
  degradation,
  inputTokens: 0,
  model: "test",
  questions: {},
  answers: {},
});

describe("held frame checks", () => {
  test("passes when the subject lands, most things are boxed and the removed one is gone", () => {
    const boxes = [found("door", 1), found("lamp", 0.5), found("cat", 0)];
    const verdict = heldVerdict(
      { chosen: "door", introduced: ["lamp"], removed: [{ id: "ghost" }] },
      ["door", "lamp", "cat"],
      boxes,
      [...boxes, found("ghost", 0.1)],
      0,
    );
    expect(verdict).toEqual({
      presence: 0.5,
      introducedPresence: 0.5,
      subjectPresence: 1,
      boxable: 2 / 3,
      lingering: 0.1,
      passed: true,
    });
  });

  test("a chosen thing that stays is the subject, and one that left hands it to what came in", () => {
    const boxes = [found("door", 0.9), found("lamp", 0.9), found("stairs", 0.1)];
    const inView = ["door", "lamp", "stairs"];
    const passes = (chosen: string | null) =>
      heldVerdict({ chosen, introduced: ["stairs"], removed: [] }, inView, boxes, boxes, 0).passed;
    expect(passes("door")).toBe(true);
    expect(passes("hall")).toBe(false);
    expect(passes(null)).toBe(false);
  });

  test("fails when half or fewer of the things in view are boxed, even with the subject there", () => {
    const boxes = [
      found("creature", 0.9),
      found("bus", 0.9),
      found("van", 0.1),
      found("sign", 0.1),
    ];
    const inView = ["creature", "bus", "van", "sign"];
    const expected = { chosen: "creature", introduced: [], removed: [] };
    expect(heldVerdict(expected, inView, boxes, boxes, 0).passed).toBe(false);
    const most = [found("creature", 0.9), found("bus", 0.9), found("van", 0.9), found("sign", 0.1)];
    expect(heldVerdict(expected, inView, most, most, 0).passed).toBe(true);
  });

  test("fails on a missing subject, a lingering removal or a degraded picture", () => {
    const boxes = [found("door", 0.9)];
    const inView = ["door", "lamp"];
    const none = { chosen: null, introduced: [], removed: [] };
    expect(heldVerdict({ ...none, introduced: ["lamp"] }, inView, boxes, boxes, 0).passed).toBe(
      false,
    );
    expect(
      heldVerdict(
        { ...none, removed: [{ id: "ghost" }] },
        ["door"],
        boxes,
        [found("ghost", 0.9)],
        0,
      ).passed,
    ).toBe(false);
    expect(heldVerdict(none, ["door"], boxes, boxes, 2).passed).toBe(false);
  });

  test("a latent start fails past the seam limit and a pinned one never does on its seam", () => {
    const boxes = [found("door", 0.9)];
    const expected = { chosen: null, introduced: [], removed: [] };
    const answer = result(boxes, 0.004);
    const check = (start: "latent" | "pinned", seam: number) =>
      momentChecks({ ...expected, start }, ["door"], boxes, answer, seam);
    expect(check("latent", 20).passed).toBe(false);
    expect(check("pinned", 20).passed).toBe(true);
    expect(check("latent", 4.44)).toEqual({
      presence: 0.9,
      introducedPresence: null,
      subjectPresence: null,
      boxable: 1,
      lingering: null,
      degradation: 0,
      seam: 4.4,
      passed: true,
    });
  });
});
